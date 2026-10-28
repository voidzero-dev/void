---
outline: deep
---

# 身份验证 {#authentication}

::: warning ⚠️ 仅适用于 Void 原生应用
Void 托管的身份验证需要运行在 Cloudflare 上的 Void 原生应用。使用元框架或 Node.js、Bun、Deno 时，请直接使用 Better Auth。
:::

Void 会为应用配置 [Better Auth](https://www.better-auth.com/)，包括数据库连接、API 路由和客户端。你可以先使用邮箱和密码登录，再按需添加社交登录提供方。

## 快速开始 {#quick-start}

### 1. 启用身份验证 {#_1-enable-auth}

从 `void/client` 导入 `auth`，即可自动启用邮箱和密码验证。添加社交登录提供方的方法见[配置](#config)。

### 2. 注册与登录 {#_2-sign-up-and-sign-in}

使用 `void/client` 提供的预配置身份验证客户端：

```tsx
import { auth } from 'void/client';

// sign up
await auth.signUp.email({
  email: 'alice@example.com',
  password: 'example-password-123',
  name: 'Alice',
});

// sign in
await auth.signIn.email({
  email: 'alice@example.com',
  password: 'example-password-123',
});
```

### 3. 保护服务端路由 {#_3-protect-a-server-route}

在需要用户登录的路由处理函数或页面 loader 中调用 `requireAuth`。它会返回当前用户；如果请求尚未通过身份验证，则抛出 `401`：

```ts
// routes/api/profile.ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

在 Pages 模式的 loader 中，如果允许未登录用户访问，可以使用 `getUser` 或 `getSession`：

```ts
// pages/dashboard.server.ts
import { defineHandler, type InferProps } from 'void';
import { getUser } from 'void/auth';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  const user = getUser();
  return { user };
});
```

### 4. 退出登录 {#_4-sign-out}

```tsx
await auth.signOut();
```

## 配置 {#config}

以下任一操作都会自动启用身份验证：

- 从 `void/auth` 导入任意内容
- 从 `void/client` 导入 `auth`
- 在 `void.config.ts` 中添加 `auth`
- 在项目根目录添加 `auth.ts` 文件

默认启用邮箱和密码验证。要添加社交登录提供方：

```json
{
  "auth": {
    "providers": ["email", "google", "github"]
  }
}
```

提供方的凭据通过 `AUTH_<PROVIDER>_CLIENT_ID` 和 `AUTH_<PROVIDER>_CLIENT_SECRET` 提供。`cognito` 还需要域名、区域和用户池 ID：设置 `AUTH_COGNITO_DOMAIN`、`AUTH_COGNITO_REGION` 和 `AUTH_COGNITO_USER_POOL_ID`，或在 `auth.ts` 中配置这些值。

完整的提供方列表见[配置参考](/zh/reference/config#auth)。

例如，`github` 使用：

- `AUTH_GITHUB_CLIENT_ID`
- `AUTH_GITHUB_CLIENT_SECRET`

## 客户端用法 {#client-usage}

`auth` 客户端在 `/api/auth` 使用 [Better Auth 的客户端 API](https://www.better-auth.com/docs/concepts/client)。Void 会根据你的框架自动选择客户端。

如需自定义客户端，从 `void/client` 导入 `createAuthClient`。

## 服务端用法 {#server-usage}

`void/auth` 提供以下服务端辅助函数：

```ts
import { getSession, getUser, requireAuth } from 'void/auth';
```

- `getUser()` 返回当前用户，类型为 `AuthUser | null`
- `getSession()` 返回 `{ user, session } | null`
- `requireAuth(c)` 返回已通过身份验证的用户，或抛出 `401`

类型注解可使用从 `void/auth` 导入的 `AuthUser` 和 `AuthSession`。字段说明见 [API 参考](/zh/reference/api/auth#authuser)。

## 运行行为 {#behavior}

身份验证会话与应用使用同一个数据库。如果尚未设置 `BETTER_AUTH_SECRET`，Void 会在部署时创建，并在后续部署中复用。

本地开发无需设置密钥。要在本地预览生产构建，需要提供 `BETTER_AUTH_SECRET`。

已登录请求的响应会带有 `Cache-Control: no-store`，因此浏览器缓存和共享缓存都不会保存用户数据。如果路由设置了 `no-store`，或同时设置了 `private` 和 `no-cache`，则保留路由自己的缓存策略。如需对重复请求返回 `304`，可将 `private, no-cache` 与 Hono 的 [`etag()`](https://hono.dev/docs/middleware/builtin/etag) 中间件一起使用。如果自行设置 `ETag`，必须让它随用户而变化，避免 `304` 复用其他账号的页面。浏览器会缓存 `private, no-cache` 页面的副本，因此用户退出登录后，仍可能通过后退按钮再次看到该页面。对于不得保留在浏览器缓存中的页面，请继续使用默认的 `no-store`。

构建产物和 `public/` 中的静态文件在已登录请求下仍保留各自的缓存策略，让浏览器可以复用缓存的 JavaScript 和 CSS。由应用处理的请求会被标记为 `private`；如果请求刷新了会话 cookie，则使用 `no-store`。

来自其他来源的 `POST`、`PUT`、`PATCH`、`DELETE` 请求和 WebSocket 连接，只有在该来源列入 `trustedOrigins` 时才会使用已登录会话。如果独立的前端需要调用应用，请将其来源加入该列表，见[自定义配置](#customization)。如果路由使用自己的 cookie，则需要自行检查请求的 `Origin`，例如使用 Hono 的 [`csrf()`](https://hono.dev/docs/middleware/builtin/csrf) 中间件。

部署在 Cloudflare 上的应用会按客户端 IP 限制身份验证请求，采用 Better Auth 的默认值，例如每 10 秒最多尝试登录 3 次。每个 Worker 实例独立计数。可以在 `auth.ts` 中通过 `rateLimit` 修改或关闭限制。要让各实例共用一个计数，设置 `rateLimit: { storage: 'database' }`；如果直接部署到 Cloudflare，还需运行 `void db generate`。

### 代理与端到端测试 {#proxies-and-end-to-end-tests}

同一个 IP 发来的所有请求共用一个计数。以下两种常见场景容易触发限制：

- 服务器代替用户调用身份验证端点，例如面向前端的后端、Vercel 或 nginx 的重写转发，或另一个 Worker 的 `fetch`。这些用户会共用该服务器的 IP。
- 端到端测试对已部署的应用反复执行注册或登录。

不要改为从 `x-forwarded-for` 读取客户端 IP，因为任何客户端都能发送这个请求头。可以给可信调用方分配一个秘密请求头，仅对携带它的请求跳过限制：

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  rateLimit: {
    customRules: {
      '/**': (request, rule) =>
        env.AUTH_TRUSTED_KEY && request.headers.get('x-auth-trusted-key') === env.AUTH_TRUSTED_KEY
          ? false
          : rule,
    },
  },
}));
```

`'/**'` 匹配所有身份验证端点。返回 `false` 会跳过限制，返回 `rule` 则为其他请求保留默认限制。在 `env.ts` 中声明 `AUTH_TRUSTED_KEY: string().optional()`，再用 `void secret put AUTH_TRUSTED_KEY` 设置它，见[环境变量](/zh/guide/env-vars#production-server-values)。

应用不再限制携带该密钥的请求，因此：

- 发送该密钥的代理必须按用户限制它转发的每一种身份验证请求，包括注册、密码重置和验证邮件。
- 测试运行器应仅向你的应用发送该密钥。绝不能将密钥放在用户浏览器中运行的代码里。

## 自定义配置 {#customization}

如需高级配置，在项目根目录创建 `auth.ts`，并导出 `defineAuth(...)`：

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ['https://example.com'],
}));
```

`defaults` 已包含 Void 的约定。请显式扩展它，配置不会自动进行深度合并。

全部可用选项见官方的 [Better Auth 选项参考](https://www.better-auth.com/docs/reference/options)。

## 数据库与迁移 {#database-and-migrations}

身份验证表与应用表存放在同一个数据库中，本地开发时由 Void 自动创建。开发服务器运行期间，保存 `auth.ts` 或它导入的本地文件，会更新 Void 为应用生成的身份验证 schema。新增的身份验证表和列会在下次启动开发服务器时创建到本地数据库中。

Void 平台会自动创建身份验证表。如果直接部署到 Cloudflare，需要将它们纳入提交到仓库的迁移：

```sh
void db generate
```

部署前审阅并提交 SQL。Void 会包含你的身份验证配置和插件所需的表，无需在 `db/schema.ts` 中重复定义，也无需运行 Better Auth CLI。
