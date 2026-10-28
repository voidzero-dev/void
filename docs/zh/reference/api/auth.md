---
outline: deep
---

# 身份验证 {#auth}

从 `"void/auth"` 导入；客户端辅助函数从 `"void/client"` 导入。

## `defineAuth(config)` {#defineauth-config}

用于自定义 Void 的 Better Auth 配置的高级接口。

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ['https://example.com'],
}));
```

**签名：**

```ts
function defineAuth(config: VoidAuthConfig): VoidAuthConfig;
```

## `getUser()` {#getuser}

返回当前已通过身份验证的用户，没有用户时返回 `null`。

```ts
import { getUser } from 'void/auth';

const user = getUser();
```

**签名：**

```ts
function getUser(): AuthUser | null;
```

## `getSession()` {#getsession}

返回当前请求的 Better Auth 身份验证状态，或 `null`。

```ts
import { getSession } from 'void/auth';

const state = getSession();
```

**签名：**

```ts
function getSession(): AuthState | null;
```

## `requireAuth(c)` {#requireauth-c}

从请求上下文中获取已通过身份验证的用户。如果没有会话，会抛出状态码为 401 的 `HTTPException`。

```ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

**签名：**

```ts
function requireAuth(c: CloudContext): AuthUser;
```

## `AuthUser` {#authuser}

Void 重新导出的 Better Auth 用户结构。

```ts
interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## `AuthSession` {#authsession}

Void 重新导出的 Better Auth 会话结构。

```ts
interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}
```

## `AuthState` {#authstate}

包含用户和会话的身份验证请求状态：

```ts
interface AuthState {
  user: AuthUser;
  session: AuthSession;
}
```

## `auth` {#auth-1}

从 `"void/client"` 导入。这是可直接使用的 Better Auth 客户端实例，已预设 `basePath: "/api/auth"`。

```ts
import { auth } from 'void/client';

await auth.signIn.email({ email, password });
await auth.signOut();
```

具体客户端方法由 Better Auth 提供。在 Pages 应用中，如果对应框架的 Better Auth 客户端包可用，Void 会自动选择它。

对于只使用 Void API 或文件路由、未启用 Void Pages 模式的常规 SPA 应用，请显式导入框架专用客户端：

```ts
import { auth } from 'void/client/react';
// or: 'void/client/vue'
// or: 'void/client/svelte'
// or: 'void/client/solid'
```

这些子路径保留与 `void/client` 相同的 `fetch`、`fetchStream` 和身份验证相关导出，同时将 `auth` 和 `createAuthClient` 绑定到 Better Auth 的框架专用包。

## `createAuthClient` {#createauthclient}

从 `"void/client"` 导入。重新导出 Better Auth 的 `createAuthClient`，供高级用法使用。

```ts
import { createAuthClient } from 'void/client';

const auth = createAuthClient({ basePath: '/api/auth' });
```
