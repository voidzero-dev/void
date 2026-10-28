---
outline: deep
---

# 什么是 Void？ {#what-is-void}

Void 是一个由 Vite 驱动、面向 Cloudflare Workers 的全栈框架。你可以使用 React、Vue、Svelte 或 Solid 构建 UI，并在同一个项目中编写服务端代码。Void 将路由、数据访问和部署串联起来，让类型贯穿整个应用。

从[快速开始](/zh/guide/quickstart)入手，创建并部署应用。如果你已经在使用元框架，请参阅相应的[集成指南](/zh/integrations/frameworks/overview)。

## 服务端路由与页面 {#server-routes-and-pages}

路由由文件定义。`routes/api/users.ts` 中的处理函数响应 `/api/users`；`pages/users/index.tsx` 中的组件渲染 `/users`。

每个页面都可以有一个配套的 `.server.ts` 文件。其中的 **loader** 读取数据，并向组件返回带有类型的 props；**action** 处理表单和其他数据变更操作，然后更新页面。服务端代码始终在服务端运行；组件首先在服务端渲染，随后在浏览器中处理导航和交互。

你可以使用[页面路由](/zh/guide/pages-routing/overview)构建全栈 UI，也可以保留自己的客户端路由，通过[类型化 fetch](/zh/guide/typed-fetch)调用[服务端路由](/zh/guide/server-routing)。你还可以构建不包含前端的 API 应用。

## 根据代码推断资源 {#resources-from-your-code}

从 `void/db` 导入 `db` 即可查询数据库。Void 在开发时提供本地数据库，并在部署时创建数据库。导入也能启用 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和[队列](/zh/guide/queues)等资源。如果需要连接已有资源，可以通过配置完成。

Drizzle schema 定义数据库类型。处理函数会推导响应类型，类型化 fetch 则会检查调用方。页面的 loader 和 action 将这些类型传递到组件和表单中。修改一个字段后，类型检查会指出应用中哪些部分需要随之调整。

## 从本地开发到生产环境 {#from-local-development-to-production}

Vite 使用 Cloudflare 运行时在本地运行应用。`void deploy` 会构建应用、创建资源、执行数据库迁移并发布应用。[环境变量](/zh/guide/env-vars)通过 schema、本地值和生产环境密钥进行管理。

你可以部署到[自己的 Cloudflare 账号](/zh/guide/deployment#deploy-to-cloudflare)，也可以连接到团队运营的 [Void 平台](/zh/guide/self-hosted-platform)。两种方式使用相同的应用 API。平台额外提供共享访问、部署历史和管理功能。

Void 也可以部署[现有框架应用和静态站点](/zh/guide/app-types)。框架继续负责路由和渲染，Void 则负责资源和部署。

## 下一步 {#next-steps}

- [快速开始](/zh/guide/quickstart)：创建你的第一个应用
- [页面路由](/zh/guide/pages-routing/overview)：loader、布局和表单
- [数据库](/zh/guide/database)：schema、查询和迁移
- [部署](/zh/guide/deployment)：Cloudflare、团队平台和 CI
