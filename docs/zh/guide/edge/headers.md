---
outline: deep
---

# 自定义响应头 {#custom-headers}

在 [`void.config.ts`](/zh/reference/config) 中，通过 `routing.headers` 定义自定义响应头。键为 URL 匹配模式，值为由 `"Name: value"` 字符串组成的数组。

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
      "/*.html": ["Cache-Control: no-cache"]
    }
  }
}
```

## 规则 {#rules}

- **匹配模式**必须以 `/` 开头。`*` 匹配任意字符，包括 `/`。
- **响应头值**使用 `Name: value` 格式，值中可以包含冒号。
- 所有匹配的规则都会合并。多条规则设置同名响应头时，以**最后一条匹配规则**为准。
- 用户定义的 `Cache-Control` 会覆盖内置默认值。没有规则匹配时，仍使用默认值。

## 作用范围 {#scope}

响应头规则适用于静态资源、SSR 页面和 API 响应，也包括从缓存返回的带哈希资源。

对于带哈希资源，可以添加响应头，但缓存和响应编码仍由平台控制。规则不能替换这些文件的 `Cache-Control`、`Content-Type`、`Content-Encoding`、`Content-Length`、`Content-Range`、`Accept-Ranges` 或 `Transfer-Encoding`。

响应头规则不适用于 ISR 缓存响应。

### Cookie 响应头 {#cookie-headers}

在 [Void 平台](/zh/guide/deployment#deploy-to-a-team-platform)上，应用通常共享一个应用域名，例如 `apps.example.com`。部署到平台时，响应头规则会对应用所有主机名上的两种响应头作特殊处理，自定义域名也包括在内：

- Void 会忽略响应头规则中的 `Set-Cookie`。
- Void 会移除响应头规则中 `Clear-Site-Data` 的 `"cookies"` 指令。`"cache"`、`"storage"` 等其他指令仍然生效。
- 如果 `Clear-Site-Data` 规则的值包含 `"*"`，Void 会忽略该规则的整个值。此时，响应会保留应用自身响应中的 `Clear-Site-Data` 值，但移除其中的 `"cookies"`。如果该值也包含 `"*"`，响应中就不会包含 `Clear-Site-Data`。

这样可以防止响应头规则设置或清除同一域名下其他应用的 Cookie。这些限制仅适用于响应头规则。应用自身的响应仍然可以设置 Cookie 和发送 `Clear-Site-Data`；在共享域名上，这些操作可能影响其他应用。请参阅[域名与资源](/zh/guide/platform/installation/domains#adding-a-domain)。

本地开发、使用 `void deploy --platform cloudflare` 部署，以及使用[其他运行时](/zh/guide/deployment#other-runtimes)时，响应头规则会按原样应用这两种响应头。

## 框架的 `_headers` 文件 {#framework-headers-files}

Void 会读取受支持框架生成的 `_headers` 文件。你配置的 `routing.headers` 规则会在其后执行，因此可以覆盖框架默认值，无需额外配置。
