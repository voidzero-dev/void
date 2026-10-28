---
outline: deep
---

# 快速开始 {#quickstart}

创建 Void 应用，在本地运行并部署。你也可以[将 Void 添加到现有的 Vite 应用](#adding-to-an-existing-vite-app)。

## 创建应用 {#create-an-app}

在空目录中安装 Void 并运行初始化命令：

::: code-group

```sh [npm]
npm install -D void
npx void init
```

```sh [pnpm]
pnpm add -D void
pnpm void init
```

```sh [yarn]
yarn add -D void
yarn void init
```

```sh [bun]
bun add -D void
bunx void init
```

```sh [vite+]
vp add -D void
vpx void init
```

:::

选择 UI 框架、项目模板和部署目标。默认构建工具是 Vite+。D1 很适合作为入门数据库：它可以在本地运行，无需单独启动数据库服务器。选择 Cloudflare 即可部署到你自己的账号，也可以暂时跳过部署配置。

你无需全局安装 Vite+。初始化过程会保留现有的包管理器版本和锁文件。

使用 pnpm 时，`pnpm create void my-app` 还会创建项目目录，并为你配置原生依赖的构建权限。

## 本地运行 {#run-locally}

::: code-group

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

```sh [bun]
bun run dev
```

```sh [vite+]
vpr dev
```

:::

打开 `http://localhost:5173`。在 Pages 项目模板中，`pages/` 存放 UI，配套的 `.server.ts` 文件包含页面在服务端运行的 loader 和 action。loader 将数据作为带类型的 props 返回给页面组件。

## 调用服务端路由 {#call-a-server-route}

编辑 `routes/api/hello.ts`；如果项目模板中没有这个文件，则创建它：

```ts
import { defineHandler } from 'void';

export const GET = defineHandler(() => {
  return { message: 'Hello from Void' };
});
```

访问 `http://localhost:5173/api/hello` 查看响应。在客户端代码中，使用 Void 的类型化 fetch 调用该路由：

```ts
import { fetch } from 'void/client';

const { message } = await fetch('/api/hello');
```

文件路径决定 URL，处理函数决定响应类型。修改处理函数中的 `message` 后，TypeScript 会根据新的数据结构检查客户端代码。

带数据库的项目模板还包含 `db/schema.ts`，其中的 Drizzle schema 定义了数据表和查询类型。Void 会在本地运行数据库，并在部署时创建所需的数据库资源。

## 部署 {#deploy}

如果你在初始化时选择了部署目标，运行：

```sh
npx void deploy
```

如果你跳过了部署配置，先选择 Cloudflare 账号：

```sh
npx void deploy --platform cloudflare
```

Void 会在需要时打开浏览器供你登录，然后构建应用、创建所需资源、执行数据库迁移，并输出部署后的 URL。后续部署会使用已保存的目标。团队平台、CI 和回滚的用法请参阅[部署应用](/zh/guide/deployment)。

## 添加到现有的 Vite 应用 {#adding-to-an-existing-vite-app}

使用你的包管理器安装 Void 并运行 `void init`，命令见[上文](#create-an-app)。初始化过程会将 `voidPlugin()` 添加到 Vite 配置中，并创建其余项目文件。如果配置需要手动编辑，CLI 会显示所需的修改。

对于 TanStack Start、React Router 或 SvelteKit 等元框架，请参阅对应的[集成指南](/zh/integrations/frameworks/overview)。

## 下一步 {#next-steps}

- [页面路由](/zh/guide/pages-routing/overview)：loader、布局和表单
- [服务端路由](/zh/guide/server-routing)：参数、中间件和校验
- [数据库](/zh/guide/database)：查询和迁移
- [环境变量](/zh/guide/env-vars)：本地配置值和生产环境密钥
- [编程 Agent](/integrations/agents)：使用 Void 内置的文档和技能

如果手动通过 pnpm 安装时报错，提示构建脚本被阻止，请运行 `pnpm approve-builds`，允许 `esbuild`、`sharp` 和 `workerd` 运行构建脚本。在 `pnpm-workspace.yaml` 的 `allowBuilds` 中设置 `better-sqlite3: false`；Void 使用其自带的二进制文件。
