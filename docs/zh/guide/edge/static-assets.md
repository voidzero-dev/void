---
outline: deep
---

# 静态资源缓存 {#static-assets-caching}

Void 会在 Cloudflare 边缘网络中缓存静态资源。带哈希的构建文件可以跨部署复用，其他文件则使用与部署关联的缓存键。

## 带内容哈希的资源 {#hashed-assets}

Vite 的 `build.assetsDir`（默认为 `assets/`）中生成的文件，文件名带有内容哈希，例如 `assets/app-Ab3xK9.js`。内容一旦改变，文件名也会改变，因此这些文件可以视为不可变资源，并采用长期缓存：

```
Cache-Control: public, max-age=31536000, immutable
```

浏览器和边缘节点可以将这些文件缓存一年，并在多次部署之间复用。

如果在 Vite 配置中自定义了 `build.assetsDir`，Void 会自动识别，并对配置目录应用不可变资源的缓存优化：

```ts
// vite.config.ts
export default defineConfig({
  build: {
    assetsDir: 'static', // hashed assets go to dist/client/static/
  },
});
```

如果将 `build.assetsDir` 设为 `""`，带哈希的文件就会放在根目录中。此时无法通过目录区分带哈希与不带哈希的文件，因此会跳过这项优化。

对于支持的元框架，Void 会自动使用框架自身的资源目录。

### Cloudflare 原生部署 {#native-cloudflare-deployments}

使用 `void deploy --platform cloudflare` 时，生成的带内容指纹的 JavaScript 包会采用不可变资源缓存。从 `public/` 复制的文件，以及自定义构建输出中使用固定文件名的文件，仍按常规方式重新验证，即使它们位于资源目录中。CSS 和其他资源继续使用 Cloudflare 的默认策略，或你配置的 `Cache-Control`。

使用[自定义响应头](/zh/guide/edge/headers)，可以为其他文件选择缓存策略。只有在内容改变时 URL 也会改变的资源，才应使用不可变资源缓存。

应用同时满足以下条件时，Cloudflare 无需启动 Worker 就能提供这些带内容指纹的 JavaScript 包，因此不会将它们计入 Worker 请求数：

- 没有全局中间件
- 没有响应头、重定向、重写或回退规则，也没有设置 `routing.notFound`
- 使用默认的 `base` 值 `/`
- 没有路由或页面匹配资源目录中的路径，该目录默认为 `assets/`
- 构建生成的带内容指纹的包不超过 99 个

其他情况下，这些包会经过 Worker，缓存策略保持不变。

## 不带内容哈希的资源 {#non-hashed-assets}

`index.html`、`favicon.ico` 等其他静态文件会缓存到下一次部署，无需手动清除。

```
Cache-Control: public, s-maxage=31536000, max-age=0, must-revalidate
```

浏览器会在每次请求时重新验证这些文件。

**会缓存的请求：**

- SPA、静态站点等非 SSR 项目的所有 `GET` 请求
- SSR 项目中带文件扩展名的 GET 请求，例如 `.ico`、`.png`、`.css`

**不会缓存的情况：**

- `/api/*` 路由，始终由 Worker 处理
- SSR 渲染的页面，即 SSR 项目中不带文件扩展名的路径
- 非 GET 请求
- 携带 `Cookie`、`Authorization` 或 `Cf-Access-Jwt-Assertion` 凭据的请求
- 状态码不是 `200` 或内容不完整的响应

### 关闭缓存 {#opting-out}

如果 Worker 在看起来像静态文件的 URL 上提供动态内容，例如在 `/avatar.jpg` 动态生成图片，可以在响应头中设置 `Cache-Control: private` 或 `Cache-Control: no-store`，防止缓存。任何响应只要其 `Cache-Control` 包含 `private`、`no-store` 或 `no-cache`，或者带有 `Set-Cookie` 响应头，就会绕过边缘缓存。

## ETag 与 304 Not Modified {#etags-and-304-not-modified}

静态资源会包含 `ETag` 响应头。浏览器重新验证未改变的文件时，Void 会返回 `304 Not Modified`，无需再次下载文件。此行为无需配置。

## 自定义响应头 {#custom-headers}

通过[自定义响应头](/zh/guide/edge/headers)，可以针对任意静态资源路径覆盖缓存响应头或添加自己的响应头。

## 导航与中间件 {#navigation-and-middleware}

除非请求需要先交给应用代码处理，否则 Void 会直接提供静态文件。API 请求会到达 Worker。应用使用中间件、`/api` 之外的路由、Pages 或 SSR 时，会先执行应用代码，再返回回退 HTML。

对于未匹配到其他路径的 HTML 导航，SPA 会返回 `index.html`，使客户端路由能够工作。如果静态站点包含 `404.html` 页面，请设置 [`routing.notFound`](/zh/reference/config#routing-notfound)：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: { notFound: '404-page' },
});
```

可选择 `single-page-application`、`404-page` 或 `none`。这些设置不会改变哪些请求会交给中间件和 API 处理函数。API 主动返回的 `404` 响应会保留其状态码和响应体。

SvelteKit、Nuxt、Analog 和 Astro 自行处理错误页面，会忽略 `routing.notFound`。使用 TanStack Start、React Router 或 vinext 直接部署到 Cloudflare 时，应通过框架的 Cloudflare 配置设置资源绑定、目录和路由策略。

## API 路由与 SSR 页面 {#api-routes-and-ssr-pages}

API 响应和 SSR 页面不会作为静态资源缓存。如果需要缓存公开的渲染页面，请使用[缓存重新验证](/zh/guide/edge/revalidation)。
