---
outline: deep
---

# 重写 {#rewrites}

重写可以在不改变浏览器地址的情况下，返回另一个路由的内容。例如，访问 `/docs` 时可以返回 `/en/docs` 的内容。如果希望浏览器跳转到目标地址，请使用[重定向](/zh/guide/edge/redirects)。

在 [`void.config.ts`](/zh/reference/config) 中定义重写规则：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    rewrites: {
      '/': '/en',
      '/docs': '/en/docs',
      '/docs/*': '/en/docs/:splat',
    },
  },
});
```

请求 `/docs/getting-started` 时，会返回 `/en/docs/getting-started` 的内容。其他语言的路径，例如 `/ja/docs/getting-started`，仍使用各自的路由。

## 规则 {#rules}

- 源路径和目标路径都必须以 `/` 开头。目标必须是应用内的路径。
- `*` 匹配任意字符，包括 `/`。在目标中使用 `:splat` 引用匹配到的部分。
- 以第一条匹配规则为准。请将具体的匹配模式放在兜底匹配模式之前。
- 重写先于静态资源和应用路由执行。

## 在中间件中动态重写 {#programmatic-rewrites-in-middleware}

目标地址需要根据请求决定时，例如根据 Cookie 选择语言，可以使用 `c.rewrite()`：

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (c.req.path.match(/^\/(en|ja)(\/|$)/)) return next();

  const locale = detectLocale(c.req);
  return c.rewrite(`/${locale}${c.req.path}`);
});
```

请返回 `c.rewrite()` 的结果。中间件会在目标路径重新运行，因此需要跳过已重写的路径，避免循环。对于只应执行一次的操作，可以使用 `c.isRewritten()` 跳过：

```ts
if (c.isRewritten()) return next();
```

目标路由如果需要检查访问权限，仍须保留这些检查。

目标中不包含 `?` 时，会保留传入的查询字符串。`c.rewrite('/search')` 会保留 `?q=...`，而 `c.rewrite('/search?q=all')` 会替换它。

编辑器会通过 [`RewriteDestination`](/zh/reference/api/rewrites#rewritedestination) 类型提示已知路由；你也可以传入动态字符串。

### 运行时重写不能访问静态资源 {#runtime-rewrites-cannot-reach-static-assets}

`c.rewrite()` 的目标是应用路由。如果要通过其他 URL 提供 `/hero.png` 等资源，请改用 `routing.rewrites` 或 `_redirects` 规则。在中间件中重写到可识别的资源扩展名时，会抛出 `VoidAssetRewriteError`。

## 获取原始 URL {#original-url-access}

`c.originalUrl()` 会返回静态规则或中间件重写前请求的 URL；如果没有发生重写，则返回 `null`。可以用它生成规范链接或检测语言：

```ts
import { defineHandler } from 'void';

export default defineHandler((c) => {
  const original = c.originalUrl();
  return c.json({ pathname: original?.pathname ?? c.req.path });
});
```

## 回退规则 {#fallbacks}

`routing.fallbacks` 使用与重写相同的匹配模式，但只有在没有资源或路由匹配时才会生效：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    fallbacks: { '/*': '/index.html' },
  },
});
```

可以为客户端路由或默认语言的兜底匹配配置回退规则。Void 路由主动返回的 `404` 仍会保留为 `404`；对于第三方框架，回退规则也可以替换框架返回的 `404` 响应。

SPA 应用已经会回退到 `/index.html`。自定义回退规则会先执行，未匹配的路径仍使用 SPA 的页面外壳，无需再自行添加 `'/*': '/index.html'`。

## `_redirects` 文件 {#redirects-file}

你也可以将规则放在 Vite 的 `publicDir` 中，该目录默认为 `public/`：

```text
# Fallback: only when no asset or route matches
/*         /index.html     200

# Rewrite: before assets and routes
/docs/*    /en/docs/:splat  200!
```

该文件也可以包含 [3xx 重定向](/zh/guide/edge/redirects)。`void.config.ts` 中的规则优先于文件规则；每组规则内部都以第一条匹配规则为准。

## 客户端导航 {#client-navigation}

重写在服务端执行。在 Pages 模式下，通过客户端的 `<Link href="/docs">` 导航时，可能获取的是 `/docs` 的 loader 数据，而非重写后 `/en/docs` 路由的数据。

如果目标路由使用不同的 loader，请通过 `<a href="/docs">` 向服务端发起完整页面请求。如果需要改变 URL，请使用重定向。

## 重写时的 ISR 缓存键 {#isr-cache-keys-with-rewrites}

要清除重写后的缓存条目，请清除目标路径的缓存，例如 `/en/docs/foo`。请参阅[缓存键与重写](/zh/guide/edge/revalidation#cache-keys-and-rewrites)。

## 使用 `X-Void-Routing` 调试 {#debugging-with-x-void-routing}

开发时，可以在浏览器的 Network（网络）面板中检查 `X-Void-Routing` 响应头，查看匹配的规则及其声明位置：

```text
X-Void-Routing: rewrite[/docs/*] -> /en/docs/:splat (void.config.ts#routing.rewrites)
X-Void-Routing: c.rewrite -> /new-path (middleware)
X-Void-Routing: pass-through
```
