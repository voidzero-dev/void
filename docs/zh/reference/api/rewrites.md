---
outline: deep
---

# 重写 {#rewrites}

URL 重写会将请求重新分发到另一个内部路径，而不改变浏览器中的 URL。Void 运行时提供的每个 Hono `Context` 都可以使用 `c.rewrite()`、`c.originalUrl()` 和 `c.isRewritten()`。完整介绍请参阅[重写指南](/zh/guide/edge/rewrites)，其中也介绍了 [`void.config.ts`](/zh/reference/config#routing) 中的静态 `routing.rewrites` / `routing.fallbacks` 配置。

## `c.rewrite(destination)` {#c-rewrite-destination}

将当前请求重新分发到 `destination`，并返回得到的 `Response`。这是服务端内部跳转，不会改变浏览器 URL。如果 `destination` 不包含查询字符串，会保留原请求的查询参数；如果 `destination` 包含查询字符串，则会替换原查询参数。`destination` 必须以 `/` 开头。已生成的已知路由可通过 [`RewriteDestination`](#rewritedestination) 自动补全，动态路径仍然可以使用任意字符串。

`c.redirect()` 跳转到内部目标时也会保留请求查询参数，但会合并而非替换：同名参数以目标中的值为准，仅原请求中存在的参数则会追加。对于发往[具名 Action](/zh/guide/pages-routing/actions-and-forms#named-actions) 的请求，无论重定向由 Action 还是中间件发起，都不会携带 Action 键，即 `POST /users/42?delete` 中的 `?delete`。不过，如果重定向后浏览器会再次发送同一个请求，就会保留该键：包括 `307` 和 `308`，以及 `PUT`、`PATCH` 或 `DELETE` 之后的 `301` 或 `302`。

```ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  const locale = c.req.header('accept-language')?.startsWith('de') ? 'de' : 'en';
  return c.rewrite(`/${locale}${new URL(c.req.url).pathname}`);
});
```

**签名：**

```ts
interface CloudContext {
  rewrite(destination: RewriteDestination): Promise<Response>;
}
```

**注意事项：**

- `destination` 必须以单个 `/` 开头，并指向内部路径。外部 URL、协议相对目标（`//host/...`）和其他非绝对路径都会立即抛出错误。跨源调用请使用 `fetch()`。
- 目标路径的最后一段如果以已知静态资源扩展名结尾，例如 `/hero.png`、`/app.css` 或 `/data.json`，会在重新分发前抛出 `VoidAssetRewriteError`，该错误从 `"void"` 导出。运行时重写不能访问资源，请改用静态 `routing.rewrites` 规则，或 `_redirects` 中的 `200!` 条目。此检查特意排除了 `.html`，因为 `.html` 路径可能对应合法的路由处理函数。请参阅[重写](/zh/guide/edge/rewrites#runtime-rewrites-cannot-reach-static-assets)。
- 每次重写跳转都会重新运行中间件。请通过 [`c.isRewritten()`](#c-originalurl-c-isrewritten) 防止副作用重复执行。
- 通过 `Link` 进行客户端 SPA 导航不会触发服务端重写，只有完整的 HTTP 请求才会触发。
- 清除重写后的 [ISR 缓存条目](/zh/guide/edge/revalidation#cache-keys-and-rewrites)时，请清除目标路径的缓存。

## `c.originalUrl()` / `c.isRewritten()` {#c-originalurl-c-isrewritten}

用于检查重写状态的上下文方法。`c.originalUrl()` 以 `URL` 对象返回重写前的 URL；首次进入、尚未重写时返回 `null`。`c.isRewritten()` 在重新分发后的上下文中返回 `true`，在原始上下文中返回 `false`。这两个方法同时适用于静态重写和中间件重写。

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (!c.isRewritten()) {
    // Only log the user-visible request, not internal rewrite hops.
    console.log(`${c.req.method} ${c.req.path}`);
  }
  await next();
});
```

**签名：**

```ts
interface CloudContext {
  originalUrl(): URL | null;
  isRewritten(): boolean;
}
```

## `RewriteDestination` {#rewritedestination}

```ts
import type { RewriteDestination } from 'void/routes';
```

在编辑器中提示已知路由模式，同时接受动态字符串。用于：

- [`c.rewrite()`](#c-rewrite-destination) 的参数类型。
- [`void.config.ts`](/zh/reference/config#routing) 中 `routing.rewrites` 和 `routing.fallbacks` 的 `destination` 条目类型。

与 [`RouteMap`](/zh/reference/api/types#routemap) 一样，`RewriteDestination` 位于虚拟模块 `void/routes` 中，路由变化时会刷新。
