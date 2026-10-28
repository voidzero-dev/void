---
outline: deep
---

# Head 管理 {#head-management}

通过 `head()`、中间件或站点默认配置，可以设置页面标题和元数据。页面自身的设置优先于中间件和配置文件。

## 页面标题和元数据 {#page-titles-and-metadata}

在 `.server.ts` 文件中导出 `head()` 函数。它接收 Hono 上下文和 loader 加载完成后的 props，并返回 `HeadDescriptor`：

```ts
// pages/posts/[slug].server.ts
import { defineHandler, defineHead } from 'void';

export interface Props {
  post: { title: string; excerpt: string; slug: string };
}

export const loader = defineHandler<Props>(async (c) => {
  const post = await getPost(c.req.param('slug'));
  return { post };
});

export const head = defineHead<Props>((c, props) => {
  // [!code highlight]
  return {
    title: props.post.title,
    meta: [
      { name: 'description', content: props.post.excerpt },
      { property: 'og:title', content: props.post.title },
    ],
  };
});
```

`head()` 只在服务端运行，并在 loader 加载完成后执行。

## 站点默认配置 {#site-defaults}

在 `void.config.ts` 中设置整个站点默认使用的 head 信息：

```json
{
  "head": {
    "titleTemplate": "%s | My Site",
    "htmlAttrs": { "lang": "en" },
    "meta": [
      { "charset": "utf-8" },
      { "name": "viewport", "content": "width=device-width, initial-scale=1" }
    ]
  }
}
```

`titleTemplate` 用于为页面标题添加统一的格式，其中的 `%s` 会替换为 `head()` 返回的 `title`。例如，页面返回 `{ title: "About" }` 时，配合上面的模板会生成 `<title>About | My Site</title>`。

## 中间件默认配置 {#middleware-defaults}

在中间件中设置 `headDefaults`，即可为所有页面提供默认值。例如，可以让主题脚本在页面首次绘制前运行：

```ts
// middleware/01.head.ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  c.set('headDefaults', {
    script: [
      {
        innerHTML: `const t = localStorage.getItem("theme");
        if (t) document.documentElement.dataset.theme = t;`,
      },
    ],
  });
  await next();
});
```

## 优先级 {#precedence}

当多个层级都提供 head 信息时，会按以下规则合并：

| 字段 | 合并规则 |
| --- | --- |
| `title` | 以页面设置为准，再使用配置中的 `titleTemplate` 为最终标题添加格式。 |
| `meta` | 按 `name` 或 `property` 去重。页面条目覆盖相同键的条目，不冲突的条目追加到列表中。 |
| `link` | 按配置、中间件、页面的顺序拼接。 |
| `script` | 按配置、中间件、页面的顺序拼接。 |
| `htmlAttrs` | 浅合并；冲突时以页面设置为准。 |
| `bodyAttrs` | 浅合并；冲突时以页面设置为准。 |

## HeadDescriptor {#headdescriptor}

```ts
interface HeadDescriptor {
  title?: string;
  meta?: Array<{
    name?: string;
    property?: string;
    content?: string;
    charset?: string;
  }>;
  link?: Array<{ rel: string; href: string; [key: string]: string | undefined }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string | undefined }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}
```

## Markdown 页面 {#markdown-pages}

Markdown 页面（`.md` 文件）会根据 frontmatter 自动生成 head 标签，无需配套的 `.server.ts` 文件：

```md
---
title: Getting Started
description: Learn how to use Void
---

Your content here...
```

这会生成 `<title>Getting Started</title>` 和 `<meta name="description" content="Learn how to use Void">`。如果配置了 `titleTemplate`，也会应用该模板。

## 客户端更新 {#client-side-updates}

在客户端导航时，标题、meta 标签和 link 标签会自动更新。

`script`、`htmlAttrs` 和 `bodyAttrs` 仅在 SSR 时应用，客户端导航时不会重新应用。
