---
outline: deep
---

# 重定向 {#redirects}

在 [`void.config.ts`](/zh/reference/config) 中，通过 `routing.redirects` 定义 URL 重定向。键是来源 URL 的匹配模式，值可以是目标地址字符串，也可以是显式指定状态码的对象。

```json
{
  "routing": {
    "redirects": {
      "/old": "/new",
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

## 规则 {#rules}

- **来源模式**以 `/` 开头。`*` 可以匹配任意字符，包括 `/`。
- **目标地址**可以是字符串，默认返回 `302`；也可以是包含 `to` 和可选 `status` 的对象。支持的状态码为 `301`、`302`、`303`、`307` 和 `308`。
- 目标地址中的 `:splat` 会替换为来源模式中 `*` 匹配到的路径部分。
- 目标地址的查询参数会与传入请求的查询参数合并，写入 `Location` 响应头。同名参数冲突时，以目标地址中的值为准。要清除传入的查询参数，请显式写入 `?` 这样的重置标记。
- 多条规则同时匹配时，**第一条匹配的规则生效**。请将具体模式放在兜底模式之前。
- 重定向在请求到达 Worker **之前**判断，因此会跳过静态资源处理、ISR 和 SSR。

## 域名级重定向 {#domain-level-redirects}

为来源地址添加 `https://host` 前缀，可以只重定向发往该域名的请求：

```json
{
  "routing": {
    "redirects": {
      "https://www.example.com/*": "https://example.com/:splat",
      "https://old-marketing.com/*": "https://example.com/:splat"
    }
  }
}
```

`_redirects` 文件也支持相同的语法：

```
https://www.example.com/*  https://example.com/:splat  301
```

只有路径的来源模式适用于项目的所有域名；带主机名前缀的来源模式只适用于指定域名。

来源地址必须使用 `https://`，并指定不含通配符或端口的具体主机名。部署规则前，先通过 `void domain add` 将域名添加到项目中。如果域名仍在等待证书验证，会在域名激活后开始重定向。

## 框架生成的 `_redirects` 文件 {#framework-redirects-files}

Void 会读取受支持框架生成的 `_redirects` 文件。你也可以将文件放在 Vite 的 `publicDir` 中：

```text
/old-page  /new-page     301
/blog/*    /posts/:splat 301
```

`void.config.ts` 中的规则优先于文件中的规则。使用 `200` 配置回退，使用 `200!` 配置[重写](/zh/guide/edge/rewrites#redirects-file)。重定向不需要 `!` 后缀。
