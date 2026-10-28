---
outline: deep
---

# 配置 {#config}

## 配置文件格式 {#config-file-format}

使用 `void.config.ts` 配置应用。若想先了解基本概念，请从[什么是 Void？](/guide) 开始。

将 `void.config.ts` 放在项目根目录，并从 `void/config` 导入 `defineConfig`。所有字段都是可选的。`void init`、`void deploy` 和 `void migrate` 可以转换旧版 Void 和 Cloudflare JSON 配置文件，并将备份保存在 `.void/config-migration/` 下。Void 创建锁文件后，请将 `void.config.ts` 和 `void.lock.json` 提交到版本控制；锁文件记录了资源 ID 和迁移历史。

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  sourceDir: 'src',
  target: 'cloudflare',
  auth: { providers: ['email', 'github', 'google'] },
  routing: {
    revalidate: { '/': 60, '*': 30 },
    headers: {
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff'],
    },
  },
  inference: {
    bindings: { db: true, kv: false },
    appType: 'spa',
    outputDir: 'dist',
  },
  worker: {
    compatibility_date: '2025-12-01',
    compatibility_flags: ['nodejs_compat'],
  },
  cloudflare: {
    name: 'my-app',
    account_id: 'your-account-id',
  },
});
```

TypeScript 提供编辑器补全和类型检查。Void 在运行时还会再次校验配置，包括运行时计算得出的值。

下方较短的 JSON 片段展示了各个字段，应将它们放在 `defineConfig({ ... })` 中。

## 字段 {#fields}

### `sourceDir` {#sourcedir}

存放 Void 约定源文件的目录，相对于项目根目录。

省略时，Void 使用项目根目录中已有的约定文件和目录：`pages/`、`routes/`、`middleware/`、`crons/`、`queues/`、`db/`、`auth.ts` 和 `env.ts`。

设置后，这些约定文件和目录会移到配置的目录下：

```json
{ "sourceDir": "src" }
```

使用上述配置时，Void 会读取 `src/pages`、`src/routes`、`src/db/schema.ts`、`src/db/migrations`、`src/auth.ts` 和 `src/env.ts`。`void.config.ts`、`vite.config.ts`、`package.json`、`tsconfig.json`、`public/` 以及仅供本地使用的 `.env` 等项目文件仍放在项目根目录。Void 不会同时扫描这两个位置；如果开发或构建时两处都存在约定源文件，请移除其中一份，确保实际使用的源目录没有歧义。

### `ai` {#ai}

`ai.gateway` 指定应用在自己的 Cloudflare 账号上运行时，`ai.provider().fetch()` 使用的 Cloudflare AI Gateway。`ai.run()`、`ai.stream()` 和 `ai.image()` 使用 Workers AI 绑定，无需网关。在 Void 平台上，网关由平台选择，此设置会被忽略。

```json
{ "ai": { "gateway": "my-gateway" } }
```

参见[在自己的 Cloudflare 账号上使用 AI](/integrations/cloudflare#ai-self-host)。

### `auth` {#auth}

Better Auth 的高层配置。

使用 `auth.providers` 选择 Void 默认启用的内置身份验证提供商。添加 `"email"` 可启用邮箱和密码登录。社交登录提供商从 `AUTH_<PROVIDER>_CLIENT_ID` 和 `AUTH_<PROVIDER>_CLIENT_SECRET` 读取凭据。`cognito` 还需要域名、区域和用户池 ID：请设置 `AUTH_COGNITO_DOMAIN`、`AUTH_COGNITO_REGION` 和 `AUTH_COGNITO_USER_POOL_ID`，或在 `auth.ts` 中配置这些值。

```json
{
  "auth": {
    "providers": ["email", "github", "google", "discord"]
  }
}
```

如果省略 `auth`，但通过导入启用了身份验证，Void 只会启用邮箱和密码登录。如需设置提供商特有的选项、权限范围、插件或自定义 OAuth 流程，请在 `auth.ts` 中使用 `defineAuth(...)`，文件位置遵循上文的源目录设置。

`auth.providers` 支持以下值：

- `email`
- `apple`
- `atlassian`
- `cognito`
- `discord`
- `dropbox`
- `facebook`
- `figma`
- `github`
- `gitlab`
- `google`
- `huggingface`
- `kakao`
- `kick`
- `line`
- `linear`
- `linkedin`
- `microsoft`
- `naver`
- `notion`
- `paybin`
- `paypal`
- `polar`
- `railway`
- `reddit`
- `roblox`
- `salesforce`
- `slack`
- `spotify`
- `tiktok`
- `twitch`
- `twitter`
- `vercel`
- `vk`
- `zoom`

### `database` {#database}

数据库后端。省略时使用 D1/SQLite（默认）。设为 `"pg"` 或 `"mysql"`，可通过 Hyperdrive 连接外部数据库。

```json
{
  "database": "pg"
}
```

| 值          | 说明                                                    |
| ----------- | ------------------------------------------------------- |
| _（省略）_  | D1（SQLite），完全由 Void 管理，无需额外配置             |
| `"pg"`      | 通过 Hyperdrive 连接 PostgreSQL；需自备数据库           |
| `"mysql"`   | 通过 Hyperdrive 连接 MySQL；需自备数据库                |

也可以使用对象，设置 Drizzle 如何命名声明时未指定名称的列：

```json
{
  "database": { "dialect": "pg", "casing": "snake_case" }
}
```

| 键        | 可选值                                  | 说明                                                                                                                                                                                |
| --------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dialect` | `"sqlite"`（默认）、`"pg"`、`"mysql"` | 数据库后端。`"sqlite"` 表示 D1                                                                                                                                                     |
| `casing`  | `"snake_case"`、`"camelCase"`           | `void/db` 查询和 `void db` 命令使用的 [Drizzle 列名格式](https://orm.drizzle.team/docs/sql-schema-declaration#camel-and-snake-casing)。省略时，使用各个对象键作为列名                                 |

使用外部数据库时：

- 将 `DATABASE_URL` 添加到 `.env`，供本地开发使用
- 从 `void/schema-pg` 或 `void/schema-mysql` 导入 schema 辅助函数
- `void/db` 在生产环境通过 Hyperdrive 连接，在本地则直接连接
- `void gen model` 会生成适用于相应数据库方言的表和列构建器

### `email` {#email}

[邮件集成](/zh/guide/email)的配置。

```json
{
  "email": {
    "from": "Acme <noreply@mail.acme.com>"
  }
}
```

| 字段   | 类型     | 说明                                                                                                           |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `from` | `string` | `sendEmail()` 的默认发件地址：单个地址，可附带显示名称（`Acme <noreply@mail.acme.com>`）                         |

开发期间，`email.from` 是本地收件箱中的默认发件地址。在 Void 平台上，请使用项目的共享发件地址或已注册的域名。

直接部署到 Cloudflare 时，此地址用于选择邮件域名和默认发件地址。请使用账号中的域名区域（Zone）或子域名；已有邮件提供商的 MX 记录会被保留。未设置 `email.from` 时，Void 会跳过自动设置，并保留你编写的 `cloudflare.send_email` 绑定和 `cloudflare.addresses`；你需要自行检查它们是否已就绪。如果无法验证自动设置，`--require-email` 仍会拒绝部署。参见[邮件设置](/zh/guide/email/domains#your-own-cloudflare-account)。

### `head` {#head}

页面模式下全站通用的 HTML `<head>` 默认配置。可设置标题模板、默认 meta 标签、链接、脚本以及 HTML/body 属性。页面级 `head()` 导出和中间件默认值会在此基础上合并，优先级为：**页面 > 中间件 > 配置**。

| 字段            | 类型                     | 说明                                                             |
| --------------- | ------------------------ | ---------------------------------------------------------------- |
| `title`         | `string`                 | 默认页面标题（会被页面的 `head()` 覆盖）                         |
| `titleTemplate` | `string`                 | 包裹最终确定的标题。`%s` 会替换为页面标题。                      |
| `meta`          | `Array<object>`          | 默认 `<meta>` 标签（按 `name`/`property` 去重，页面优先）         |
| `link`          | `Array<object>`          | 默认 `<link>` 标签（按配置、中间件、页面的顺序拼接）             |
| `script`        | `Array<object>`          | 默认 `<script>` 标签（按配置、中间件、页面的顺序拼接）           |
| `htmlAttrs`     | `Record<string, string>` | `<html>` 上的属性（浅合并，页面优先）                            |
| `bodyAttrs`     | `Record<string, string>` | `<body>` 上的属性（浅合并，页面优先）                             |

```json
{
  "head": {
    "titleTemplate": "%s | My Site",
    "htmlAttrs": { "lang": "en" },
    "meta": [
      { "charset": "utf-8" },
      { "name": "viewport", "content": "width=device-width, initial-scale=1" }
    ],
    "link": [{ "rel": "icon", "href": "/favicon.svg" }]
  }
}
```

完整的合并规则、`HeadDescriptor` 结构和页面级用法，参见[页面头部管理](/zh/guide/pages-routing/head)。

### `output` {#output}

输出模式，控制页面的默认渲染策略。

| 值                   | 默认预渲染        | 页面级覆盖                       | 预渲染时机                 |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"`（默认）  | `false`           | `export const prerender = true`  | 部署时（平台 ISR）         |
| `"static"`           | `true`            | `export const prerender = false` | 构建时，或部署时的构建后阶段 |

设为 `"static"` 时，页面会预渲染为 HTML，输出到 `dist/client/`。单个页面可通过 `export const prerender = false` 退出预渲染。动态页面需要提供 `getPrerenderPaths()` 才能预渲染。

省略或设为 `"server"` 时，页面会在收到请求时由服务器渲染。单个页面可通过 `export const prerender = true` 启用部署时预渲染，也可以通过 `export const ssr = false` 不在服务器端渲染组件 HTML。

```json
{ "output": "static" }
```

### `remote` {#remote}

在本地开发期间使用已部署 Void 项目的 D1、KV 和 R2 资源。写入操作会影响真实数据。参见[远程开发](/zh/guide/remote-dev)。

```json
{ "remote": true }
```

**使用要求：**

- 必须已登录（`void account login`）
- 必须已关联项目（`void project link`）
- 仅影响 D1（`DB`）、KV（`KV`）和 R2（`STORAGE`）绑定

也可以通过 `VOID_REMOTE=1` 环境变量启用远程模式，无需修改 `void.config.ts`：

```bash
VOID_REMOTE=1 pnpm dev
```

### `sandbox` {#sandbox}

启用并配置 Cloudflare 沙箱。从 `void/sandbox` 导入时会自动启用。

```json
{
  "sandbox": {
    "image": "./Dockerfile.sandbox",
    "platformImage": "registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>",
    "instanceType": "standard-1"
  }
}
```

| 字段                | 类型     | 默认值                      |
| ------------------- | -------- | --------------------------- |
| `binding`           | `string` | `SANDBOX`                   |
| `className`         | `string` | `SandboxV1`                 |
| `containerName`     | `string` | `void-sandbox-v1`           |
| `image`             | `string` | 随包附带的 Node.js Dockerfile |
| `imageBuildContext` | `string` | `image` 所在目录            |
| `platformImage`     | `string` | `cloudflare/debian-trixie`  |
| `instanceType`      | `string` | `lite`                      |

支持的容器规格为 `lite` 以及 `standard-1` 到 `standard-4`。原生部署会使用 Docker 根据 Dockerfile 构建镜像；使用镜像仓库中的镜像时，必须提供 Cloudflare 托管镜像仓库中通过摘要固定版本的引用。自定义镜像必须包含版本匹配的 Sandbox SDK 辅助程序。使用本地 Dockerfile 部署到托管平台时，需要提供 `platformImage`。镜像设置和运行时示例，参见[沙箱](/zh/guide/sandboxes)。

沙箱需要 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) 和 Containers 访问权限。托管平台的运行时令牌需要 Account / Containers: Edit 和 Account / Cloudchamber: Edit 权限。参见[沙箱部署](/zh/guide/sandboxes#deployment)。

### `target` {#target}

部署的目标运行时。默认为 `"cloudflare"`。

| 值             | 说明                                                      |
| -------------- | --------------------------------------------------------- |
| `"cloudflare"` | Cloudflare Workers（默认），支持完整的平台功能            |
| `"node"`       | Node.js，使用 `@hono/node-server`                        |
| `"bun"`        | Bun，使用 `Bun.serve()`                                  |
| `"deno"`       | Deno，使用 `Deno.serve()`                                |

非 Cloudflare 目标不允许导入 Cloudflare 绑定（`void/db`、`void/kv`、`void/auth`、`void/storage`、`void/ai`、`void/sandbox`、`void/env`）。在这些目标上导入其中任何一个模块，都会产生编译时错误。基于文件的路由、中间件和 `void/client` 均可正常使用。

Void 管理的 WebSocket 路由文件（`*.ws.ts`）会编译为 Durable Objects，因此仅支持 Cloudflare。非 Cloudflare 目标并不禁止使用 `void/ws` 子路径，所以只要运行时提供类似浏览器的 `WebSocket` 实现，客户端 `connect()` 代码仍可被打包。

```json
{ "target": "node" }
```

### `worker` {#worker}

常用的 Cloudflare Workers 配置。`void init` 会在这里固定 `compatibility_date`。如果项目既没有配置文件，也没有兼容性日期，首次启动开发服务器或构建时会创建仅包含此日期的 `void.config.ts`，并将 `.void-wrangler.jsonc` 添加到 `.gitignore`。Astro、SvelteKit、Nuxt 和 Analog 应用会将日期写入根目录的 `wrangler.jsonc`，由各自的适配器默认读取。如果项目已有 `wrangler.toml`，则会将日期写入 `void.json`。`d1_databases`、`kv_namespaces` 和 `r2_buckets` 等绑定数组应放在 [`cloudflare`](#cloudflare) 中，Void 会在部署时保留其中的自定义设置和已解析的 ID。

| 字段                  | 类型       | 说明                                   |
| --------------------- | ---------- | -------------------------------------- |
| `compatibility_date`  | `string`   | Cloudflare Workers 兼容性日期          |
| `compatibility_flags` | `string[]` | Cloudflare Workers 兼容性标志          |
| `vars`                | `object`   | Worker 明文变量                       |
| `limits`              | `object`   | 覆盖 Worker 资源限制                  |

```json
{
  "worker": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"],
    "vars": {
      "PUBLIC_API_BASE": "https://api.example.com"
    }
  }
}
```

`worker.vars` 的值必须是字符串。根目录的 `.env` 值仅在本地开发期间覆盖它们。生产构建不会加载 `.env`，并且不允许 `worker.vars` 使用在 `env.ts` 中声明为服务器端键的名称。生产环境的服务器端值应使用 `void secret put` 设置。

托管部署会将 `worker.vars` 作为明文绑定。若存在同名远程密钥，则远程密钥优先。要改为使用配置中的变量，请移除该远程密钥并重新部署。删除密钥会立即影响正在运行的 Worker，因此请在维护窗口内安排这次迁移。

`worker.limits.cpu_ms` 设置每个请求的 CPU 时间上限，范围为 1 到 300000 毫秒。在 Void 平台上，如果此值超过账号套餐的上限，部署会失败；请先在 `void.config.ts` 中调低后重试。回滚则会将旧值限制在当前套餐允许的上限内。直接部署时，[由 Cloudflare 执行此限制](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)：Workers Free 每个请求最多允许 10 毫秒，Workers Paid 最多允许 300000 毫秒。

```json
{
  "worker": {
    "limits": {
      "cpu_ms": 30000
    }
  }
}
```

### `cloudflare` {#cloudflare}

直接面向 Cloudflare 构建和部署时使用的完整 Cloudflare Worker 配置。自定义绑定、`name`、`account_id`、路由、服务、变量、迁移以及其他 Cloudflare 字段均放在这里。Void 会将这些字段透传到生成的 Cloudflare 构建配置中。在这里编辑的设置，优先于 Void 此前记录在 `void.lock.json` 中的值。

```ts
// Inside defineConfig({ ... })
cloudflare: {
  name: 'my-app',
  d1_databases: [{ binding: 'ANALYTICS', database_name: 'analytics', database_id: '...' }],
  vars: { PUBLIC_API_BASE: 'https://api.example.com' },
},
```

Void 会为自身工具生成 Cloudflare 配置，并在 `void.lock.json` 中记录已创建的资源 ID 和仅追加的迁移历史。锁文件变化时，请将其提交到版本控制。根目录的 `wrangler.jsonc` 和 `wrangler.json` 会在运行 `void init` 或 `void deploy` 时被迁移；Void 会在 `.void/config-migration/` 下保留备份。

如果需要移除 Void 此前生成的值，请从 `void.lock.json` 的 `resolved` 对象中删除它。下次运行命令时，Void 会刷新生成的 Cloudflare 文件。需要长期保留的自定义设置应放在 `void.config.ts` 的 `cloudflare` 中。

### `deploy.cloudflare.mode` {#deploy-cloudflare-mode}

直接部署到 Cloudflare 时，默认使用 `staged`：Void 会先检查新的 Worker，再将生产流量转给它。如果 Cloudflare 无法对已有的 Durable Object Worker 进行分阶段部署，请先审查待部署的 Worker 和数据库变更，再选择 `atomic`：

```ts
// Inside defineConfig({ ... })
deploy: { cloudflare: { mode: 'atomic' } },
```

此选择会应用于后续的 `void deploy`。原子部署会先将流量转给新的 Worker，再由 Void 检查其是否就绪；Durable Object 类迁移无法跨越其迁移边界回滚。如果只想对单次部署使用此模式，可以改用 `--atomic`。`deploy` 是 Void 设置，不会传递到 Cloudflare 的 Worker 配置中。

### `routing` {#routing}

用于响应头、重定向、重写和缓存的路由与边缘配置。

#### `routing.headers` {#routing-headers}

自定义响应头。键为 URL 模式，值为 `"Name: value"` 字符串组成的数组。详见[自定义响应头](/zh/guide/edge/headers)。

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
    }
  }
}
```

#### `routing.redirects` {#routing-redirects}

URL 重定向。键为源 URL 模式，值为目标字符串（默认使用 302），也可以是包含 `to` 和可选 `status`（`301`、`302`、`303`、`307`、`308`）的对象。详见[重定向](/zh/guide/edge/redirects)。

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

#### `routing.rewrites` {#routing-rewrites}

URL 重写。键为源 URL 模式，值为目标路径。从目标路径提供内容，浏览器 URL 保持不变。详见[重写](/zh/guide/edge/rewrites)。

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs/*": "/en/docs/:splat"
    }
  }
}
```

目标使用 `RewriteDestination` 类型：带类型信息的路由模式与 `string` 的组合，既能为已知路由提供自动补全，也接受动态路径。参见[编程式重写](/zh/guide/edge/rewrites#programmatic-rewrites-in-middleware)。

#### `routing.fallbacks` {#routing-fallbacks}

兜底重写。结构与 `rewrites` 相同，但仅在没有静态资源或路由匹配请求时触发（即原本会返回 404 的请求）。适用于 SPA 壳页面或默认语言的兜底规则，避免它们抢先匹配实际路由。详见[重写 → 兜底规则](/zh/guide/edge/rewrites#fallbacks)。

```json
{
  "routing": {
    "fallbacks": {
      "/*": "/index.html"
    }
  }
}
```

#### `routing.isr` {#routing-isr}

Void ISR 缓存的布尔开关。省略或设为 `true` 时，Void 会根据重新验证和预渲染设置推断缓存行为。设为 `false` 会在整个应用中禁用 ISR 和边缘预渲染，页面级导出也不例外：

```json
{
  "routing": {
    "isr": false
  }
}
```

使用 `output: "static"` 在构建时生成 HTML 不受影响。将 `isr` 设为 `true`，可重新启用已配置的缓存策略。

#### `routing.revalidate` {#routing-revalidate}

ISR 缓存重新验证的 TTL，单位为秒，可全局设置或按路径设置。详见[缓存重新验证](/zh/guide/edge/revalidation)。

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "*": 30
    }
  }
}
```

#### `routing.revalidateQueryAllowlist` {#routing-revalidatequeryallowlist}

ISR 缓存键中需要保留的查询参数。键为源 URL 模式，值为要保留的查询参数名称。每次请求匹配路径时，列出的参数都会成为缓存键的一部分，其他查询参数则不会包含在缓存键中。省略时，ISR 缓存键会丢弃传入的所有查询参数，避免缓存变体无限增加。

```json
{
  "routing": {
    "revalidateQueryAllowlist": {
      "/search": ["q"],
      "/products/*": ["variant", "currency"],
      "*": []
    }
  }
}
```

#### `routing.prerender` {#routing-prerender}

部署时要预渲染为静态 HTML 的路径。每个路径必须以 `/` 开头。详见[边缘预渲染](/zh/guide/edge/prerendering)。

```json
{
  "routing": {
    "prerender": ["/", "/about", "/pricing"]
  }
}
```

#### `routing.notFound` {#routing-notfound}

覆盖静态资源层对既未匹配资源、也未匹配 Worker 路由的请求所返回的响应。可设为 `"single-page-application"`、`"404-page"` 或 `"none"`。省略时，Void 会自动推断，参见[静态资源](/zh/guide/edge/static-assets#navigation-and-middleware)。

```json
{
  "routing": {
    "notFound": "404-page"
  }
}
```

对于生成了 `404.html` 的静态站点，使用 `"404-page"`；使用客户端路由时，选择 `"single-page-application"`；若要保留 Worker 自己的 404 响应，则使用 `"none"`。API 和中间件路由保持不变。

SvelteKit、Nuxt、Analog 和 Astro 使用自己的错误页面，会忽略此设置。使用 TanStack Start、React Router 或 vinext 直接部署到 Cloudflare 时，请在框架的 Cloudflare 配置中设置完整的静态资源策略。参见[静态资源](/zh/guide/edge/static-assets#navigation-and-middleware)。

### `inference` {#inference}

构建时推断的配置，包括 Void 如何检测应用类型、绑定和构建流程。

#### `inference.bindings` {#inference-bindings}

显式控制推断出的 Cloudflare 绑定。省略时，会通过扫描源文件中的绑定用法[自动推断](/zh/reference/resource-inference)。显式值会覆盖对应的绑定，未指定的绑定仍会进行推断。即使 `db` 为 `false`，身份验证和已纳入版本控制的迁移仍然需要数据库。

每个绑定接受 `true`（使用默认名称）、`false`（禁用）或字符串（自定义绑定名称）：

```json
{ "inference": { "bindings": { "db": true, "kv": false, "storage": "MY_BUCKET", "ai": "MY_AI" } } }
```

| 键        | 默认绑定        | 类型          | 自定义名称               |
| --------- | --------------- | ------------- | ------------------------ |
| `db`      | `DB`            | `D1Database`  | `"db": "MY_DB"`          |
| `kv`      | `KV`            | `KVNamespace` | `"kv": "MY_KV"`          |
| `storage` | `STORAGE`       | `R2Bucket`    | `"storage": "MY_BUCKET"` |
| `ai`      | `AI`            | `Ai`          | `"ai": "MY_AI"`          |
| `email`   | —               | —             | 仅支持布尔值             |

自定义绑定名称在开发和部署期间都适用于 `void/db`、`void/kv` 和 `void/storage`。直接部署到 Cloudflare 时，`void/ai` 也支持自定义 AI 绑定名称；托管的 Workers AI 使用平台代理。

`email` 是布尔类型的功能开关。设为 `true`，无需从 `void/email` 导入即可启用[邮件功能](/zh/guide/email)和本地邮件收件箱；设为 `false` 则禁用它们。在 Void 平台上，邮件通过平台代理发送。直接部署到 Cloudflare 的设置过程会在 `void.lock.json` 中记录一个 `SEND_EMAIL` 绑定；参见 [`email.from`](#email)。

#### `inference.build` {#inference-build}

覆盖构建命令。适用于拥有自有 CLI 的框架（Nuxt、Astro），或使用自定义构建脚本的静态应用。省略时，CLI 会使用为当前应用类型检测到的默认构建命令。此设置适用于所有应用类型，包括 `"void"`（默认命令为 `vite build`）。

```json
{ "inference": { "build": "nuxt build --preset cloudflare-module" } }
```

此命令通过 shell 从项目根目录运行，且 `PATH` 包含项目自身的 `node_modules/.bin`，因此可以直接使用可执行文件名，也可以通过 `&&` 串联命令：

```json
{ "inference": { "build": "vitepress build && vite build" } }
```

通过这种串联方式，可以将静态站点生成器和 Void 后端一起部署，参见[为静态站点添加后端](/zh/guide/app-types#adding-a-backend-to-a-static-site)。

#### `inference.scanDirs` {#inference-scandirs}

覆盖[绑定推断](/zh/reference/resource-inference)要扫描的目录。路径相对于项目根目录。此设置会替换当前模式的默认目录。

```json
{ "inference": { "scanDirs": ["src", "lib", "workers"] } }
```

#### `inference.appType` {#inference-apptype}

应用类型。省略时，会在首次部署时自动检测。参见[支持的应用类型](/zh/guide/app-types)。

- `"void"`：Worker 加静态资源，包含 API 路由、SSR 和后台任务
- `"framework"`：TanStack Start、React Router、SvelteKit、Nuxt 或 Astro 等元框架应用
- `"static"`：由 VitePress、纯 HTML 或外部工具生成的完整 HTML 文件。未匹配的路径返回 `404.html` 或 404 响应。
- `"spa"`：带 SPA 兜底的静态输出。非文件路径会回退到 `index.html`，并返回 `200` 状态，使客户端路由开箱即用。

#### `inference.outputDir` {#inference-outputdir}

静态部署的输出目录，相对于项目根目录。仅在 `inference.appType` 为 `"spa"` 或 `"static"` 时适用。默认为 `"dist"`。
