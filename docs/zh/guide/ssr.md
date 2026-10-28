---
outline: deep
---

# 自定义 SSR {#custom-ssr}

使用自定义 SSR 时，路由、数据加载、HTML 页面模板和水合代码都由你自行决定。如果希望由 Void 处理这些部分，可以使用[页面路由](/zh/guide/pages-routing/overview)。

## 创建应用 {#create-the-app}

先创建根组件。下面的 React 示例会根据请求路径渲染不同的页面：

```tsx
// src/App.tsx
export default function App({ url }: { url: string }) {
  return url === '/about' ? <main>About</main> : <main>Home</main>;
}
```

## 入口文件 {#required-entries}

创建以下两个入口文件：

- `src/main.ssr.ts` 或 `src/main.ssr.tsx`
- `src/main.client.ts` 或 `src/main.client.tsx`

一个用于服务端，一个用于客户端，两者都需要提供。

## 渲染 API {#render-api}

用 `defineRender()` 包装服务端渲染函数，并返回 HTML 响应。将 `assetTags.css` 和 `assetTags.preloads` 放入 `<head>`，将 `assetTags.body` 放在 `</body>` 之前：

```tsx
// src/main.ssr.tsx
import { renderToString } from 'react-dom/server';
import { defineRender } from 'void';
import App from './App';

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.raw.url);
  const html = renderToString(<App url={url.pathname} />);
  return new Response(
    `<!doctype html>
<html>
  <head>${assetTags.css}${assetTags.preloads}</head>
  <body>
    <div id="root">${html}</div>
    ${assetTags.body}
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
});
```

你也可以导出具名函数 `render(c, assetTags)`，函数签名保持一致。类型说明见 [`defineRender`](/zh/reference/api/handlers#definerender-handler)。

## 在浏览器中水合 {#hydrate-in-the-browser}

在客户端入口中，对同一个组件进行水合：

```tsx
// src/main.client.tsx
import { hydrateRoot } from 'react-dom/client';
import App from './App';

hydrateRoot(document.getElementById('root')!, <App url={window.location.pathname} />);
```

## 缓存 {#caching}

SSR 页面的缓存可以采用先返回缓存内容、再后台更新的方式，详见[缓存重新验证](/zh/guide/edge/revalidation)。

API 路由和静态文件优先于自定义渲染处理。未匹配的非 API 请求会交给 `render(c, assetTags)`。
