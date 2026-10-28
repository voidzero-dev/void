---
outline: deep
---

# 边缘预渲染 {#edge-prerendering}

在部署时预渲染页面，让第一位访客也能收到缓存的 HTML。

- [Markdown 页面](/zh/guide/pages-routing/markdown)会自动预渲染。
- 没有配套 loader 且不含动态参数的 [Islands 页面](/zh/guide/pages-routing/islands)也会自动预渲染。

## 静态页面（无参数） {#static-pages-no-params}

在配套的 `.server.ts` 文件中导出 `prerender = true`：

```ts
// pages/about.server.ts
export const prerender = true;
```

没有动态参数的页面不需要 `getPrerenderPaths()`。

## 动态页面（有参数） {#dynamic-pages-with-params}

对于带 URL 参数的页面，还需导出 `getPrerenderPaths()`，指定要预渲染的参数组合：

```ts
// pages/blog/[slug].server.ts
export const prerender = true;

export async function getPrerenderPaths() {
  // Return param objects matching the URL pattern
  return [{ slug: 'hello-world' }, { slug: 'getting-started' }];
}
```

## 自定义 SSR {#custom-ssr}

在自定义 SSR 模式（`src/main.ssr.ts`）中，从模块顶层导出 `getPrerenderPaths()`。由于没有基于文件的路由，需要返回完整的路径字符串：

```ts
// src/main.ssr.ts
export const prerender = true;

export async function getPrerenderPaths() {
  return ['/', '/about', '/blog/hello-world'];
}
```

## 与重新验证的关系 {#relationship-to-revalidation}

在 `void.config.ts` 中设置 `routing.isr: false`，会禁用重新验证（ISR）和本页介绍的边缘预渲染，即使页面单独启用了预渲染也不会生效。这不影响 `output: "static"` 在构建时生成 HTML。

预渲染页面的重新验证 TTL 默认为一年。部署会清除 ISR 缓存。

可以为单个页面覆盖 TTL：

```ts
// pages/about.server.ts
export const prerender = true;
export const revalidate = 3600;
```

如果页面缓存在下次部署前过期，下一次请求必须等待页面重新渲染。

## 具体行为 {#behavior-details}

- 每次部署会执行一次预渲染，时机在流量切换到新版本之前。预渲染的页面缓存在边缘。
- 只有重新验证 TTL 为正数的路径才会预渲染，TTL 为 `0` 的路径会跳过。
- 预渲染失败会记录日志，但不会阻止部署。页面仍会像往常一样，在首次请求时渲染。
