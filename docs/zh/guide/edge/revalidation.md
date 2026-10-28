---
outline: deep
---

# 缓存重新验证（ISR） {#revalidation-isr}

缓存重新验证会缓存渲染后的页面，并在后台更新。缓存页面过期后，访客仍可读取已有页面，同时由 Worker 在后台渲染新版本。这通常称为[增量静态再生（ISR）](https://vercel.com/docs/incremental-static-regeneration)。

缓存重新验证可配合 [Void SSR](/zh/guide/ssr)、[Pages 模式](/zh/guide/pages-routing/overview)或[支持的 SSR 框架](/zh/integrations/frameworks/overview)使用。对于框架应用，Void 缓存的是公开的 HTML 文档响应，不会缓存框架的数据请求。

如果希望在整个应用中关闭 Void 的 ISR 缓存，同时保留各页面的设置，可在 `void.config.ts` 中设置 `"routing": { "isr": false }`。此设置会覆盖各页面的重新验证和预渲染策略。将 `isr` 改回 `true`，即可重新启用这些策略。通过 `output: "static"` 在构建时生成 HTML 的行为不受影响。

## 启用缓存重新验证 {#enabling-revalidation}

在 `void.config.ts` 中添加 `routing.revalidate` 字段，设置以秒为单位的缓存有效期（TTL）：

```json
{
  "routing": {
    "revalidate": 60
  }
}
```

将 `revalidate` 设为 `0` 会关闭缓存重新验证，行为等同于普通 SSR。

## 按路径设置 {#per-path-revalidation}

可以使用对象，为不同 URL 模式设置不同的 TTL：

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "/user/*": 0,
      "*": 30
    }
  }
}
```

规则按顺序匹配，以首个匹配项为准。通配符 `*` 匹配任意字符，包括 `/`。

特殊值：

- `31536000`（一年）：实际上会缓存到下一次部署，因为部署会清除 ISR 缓存
- `0`：从不缓存，始终由 Worker 渲染，等同于该路径使用普通 SSR

## 按页面设置（Pages 模式） {#per-page-revalidation-pages-mode}

在 [Pages 模式](/zh/guide/pages-routing/overview)中，可以从 `.server.ts` 文件导出 `revalidate` 值，覆盖全局配置中对该页面的设置：

```ts
// pages/products/index.server.ts
export const revalidate = 120; // cache for 2 minutes

export const loader = defineHandler(async (c) => {
  // ...
});
```

页面设置的优先级高于 `void.config.ts` 中的路径模式。

页面导出的 `revalidate` 也会作用于 URL 匹配该页面模式的 `routes/` 处理函数。例如，`pages/[...slug].server.ts` 导出 `revalidate` 后，Void 也可能缓存 `routes/now.ts` 的 `GET` 响应。Void 从不缓存 `/api` 下的路径。如果希望路由处理函数的响应不进入缓存，请为其设置 `x-revalidate: 0`，详见[按响应覆盖 TTL](#per-response-ttl-override)。

## 优先级 {#precedence}

多个来源都设置了重新验证的 TTL 时，作用范围更具体的设置优先：

1. `x-revalidate` 响应头，针对单个响应
2. `.server.ts` 导出，针对单个页面，仅适用于 Pages 模式
3. `void.config.ts` 中 `routing.revalidate` 匹配的路径模式
4. `void.config.ts` 中 `routing.revalidate` 的全局数值或 `"*"` 回退项

## 缓存重新验证如何工作 {#how-revalidation-works}

首次请求会渲染并缓存页面。缓存尚未过期时，访客可以立即取得页面。缓存过期后，Void 会继续返回已有页面，同时在后台渲染新版本。

如果请求没有对应的缓存条目，则需要等待页面渲染完成。

## 按响应覆盖 TTL {#per-response-ttl-override}

路由处理函数可以设置 `x-revalidate` 响应头，覆盖某个响应的 TTL：

```ts
export const GET = defineHandler(async (c) => {
  // Don't cache this particular response
  c.header('x-revalidate', '0');

  return c.html('...');
});
```

- `x-revalidate: 0`：不缓存此响应
- `x-revalidate: 300`：缓存 5 分钟，替代默认有效期

只缓存完整的 `200` 响应。带有 `Cache-Control: private`、`no-store`、`no-cache` 或任意 `Set-Cookie` 响应头的响应，仅用于当前请求，不会进入共享缓存。如果公开页面开始返回上述响应头之一，Void 会移除其已缓存的响应。

如果响应随请求头变化，例如使用 `Vary: Accept-Language` 或 `Vary: Origin`，则会实时渲染。`Vary: *` 也会禁用共享缓存。Void 支持 `X-VoidPages`，因为 HTML 和 Pages JSON 的响应分别缓存。

## 绕过缓存 {#cache-bypass}

带有 `Cookie`、`Authorization` 或 Cloudflare Access 的 `Cf-Access-Jwt-Assertion` 请求头时，请求会完全绕过 ISR 缓存，始终交给 Worker。经过身份验证的响应不会在用户之间共享，即使 Access 身份验证没有提供 Cookie 也是如此。

## 缓存键与重写 {#cache-keys-and-rewrites}

通过路由配置进行重写时，缓存键会同时包含目标路径和原始路径。因此，直接请求 `/en/docs/foo`，与请求 `/docs/foo` 后重写到该目标，会使用不同的缓存条目。

查询参数默认不计入缓存键。如果某些参数需要对应独立的缓存响应，请添加 `routing.revalidateQueryAllowlist`。携带其他查询参数的请求仍会取得已有的缓存页面；如果尚无缓存，则会实时渲染，但不保存结果。因此，页面读取的每个参数都应加入 `routing.revalidateQueryAllowlist`。中间件中的 `c.rewrite()` 在 ISR 查找缓存后执行，不会创建额外的缓存变体。

使用 `revalidate({ paths })` 清除目标路径的缓存。清除 `/en/docs/foo` 会同时移除直接访问和重写访问的缓存变体。只清除 `/docs/foo` 则无法移除它们，因为缓存条目存储在目标路径下。

## 按需重新验证 {#on-demand-revalidation}

可以在路由处理函数中，通过代码清除 ISR 缓存条目：

```ts
import { revalidate } from 'void/isr';

export const POST = defineHandler(async (c) => {
  // ... update content in database ...

  // Purge specific pages
  await revalidate({ paths: ['/', '/blog/hello-world'] });

  // Or purge all cached pages
  await revalidate({ all: true });

  return c.json({ ok: true });
});
```
