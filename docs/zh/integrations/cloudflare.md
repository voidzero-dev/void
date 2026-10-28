---
outline: deep
---

# Cloudflare {#cloudflare}

Void 运行在 Cloudflare Workers 上。它会检测应用使用的资源、创建绑定，并部署到你的账号。

## 绑定 {#bindings}

在 Void 路由和中间件中，使用 `c.env`：

```ts
// routes/api/users.ts
import { defineHandler } from 'void';

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM users').all();
  return c.json({ users: results });
});
```

TanStack Start 和 React Router 可以从 `cloudflare:workers` 导入绑定：

```ts
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```

其他框架使用各自的绑定访问方式。请参阅对应[框架的配置指南](/zh/integrations/frameworks/overview)。

### TypeScript 配置 {#typescript-setup}

将 `void/env` 添加到 TypeScript 的类型列表中：

```json
{
  "compilerOptions": {
    "types": ["void/env"]
  }
}
```

这会提供绑定类型和 Workers 运行时类型。

### 可用绑定 {#available-bindings}

| 绑定             | 资源            | 在应用中使用                     |
| ---------------- | --------------- | --------------------------------- |
| `DB`             | D1              | `c.env.DB` 或 `void/db`           |
| `KV`             | KV              | `c.env.KV` 或 `void/kv`           |
| `STORAGE`        | R2              | `c.env.STORAGE` 或 `void/storage` |
| `AI`             | Workers AI      | `c.env.AI` 或 `void/ai`           |
| `ASSETS`         | 静态资源        | `c.env.ASSETS.fetch(request)`     |
| `QUEUE_*`        | Queues          | `defineQueue()` 或 `void/queues`  |
| 由文件名生成     | Durable Objects | `durable-objects/` 中的模块       |

需要启用、禁用或重命名推断出的绑定时，请使用[绑定配置](/zh/reference/resource-inference#explicit-binding-overrides)。

## Cloudflare 配置 {#cloudflare-configuration}

在 `void.config.ts` 中定义 Worker 设置：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  worker: {
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
  },
  cloudflare: {
    name: 'my-app',
    services: [{ binding: 'API', service: 'my-api-worker' }],
  },
});
```

将绑定数组、资源 ID、路由和服务绑定放在 `cloudflare` 下。Void 会保留你配置的绑定，并补充推断出但尚未配置的资源。对于兼容性设置和变量，`worker` 字段的优先级更高。请参阅[配置](/zh/reference/config)。

当 Void 记录了资源 ID 或 Durable Object 迁移时，请提交 `void.lock.json`。不要将生成的 Cloudflare 配置加入 Git。需要指定适配器配置路径的框架使用 `.void-wrangler.jsonc`；对应配置指南会列出必需的选项。

在 `env.ts` 中声明环境变量，将本地值放在 `.env` 中，并使用 `void secret put` 设置生产环境的服务端值。请参阅[环境变量](/zh/guide/env-vars)。

## 部署到你自己的 Cloudflare 账号 {#deploy-to-your-own-cloudflare-account}

在 `void init` 中选择 Cloudflare，然后部署：

```sh
void deploy
```

Void 会打开浏览器供你登录；如果你有多个账号，还会询问使用哪个账号。如果浏览器没有打开，请访问终端中显示的链接，并确认终端中的验证码。

如果之后再配置部署，请运行 `void connect --platform cloudflare`。若只想在某次部署中选择 Cloudflare，请运行：

```sh
void deploy --platform cloudflare
```

使用 `void cloudflare login`、`status` 和 `logout` 管理会话。

### 部署现有 Worker {#deploy-an-existing-worker}

对于已经直接部署到 Cloudflare 的现有 Void 应用，请保留根目录下的 `wrangler.jsonc` 或 `wrangler.json`，然后运行：

```sh
void deploy
```

如果尚未选择部署目标，Void 会询问是否关联现有 Worker。接受后即可登录并部署。Void 会将配置迁移到 `void.config.ts` 和 `void.lock.json`，保留绑定、变量、密钥、路由和定时任务。请提交这两个文件。

首次部署时先保持现有应用的功能范围。完成关联后，再添加资源、身份验证、迁移或其他运行时功能。如果 Worker 存在较新但尚未激活的上传版本，请先在 Cloudflare 中激活或删除该版本，然后重试。

就绪检查需要已有的[版本元数据绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)，或能够访问 [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)。如果两者都不可用，Void 会在激活前停止。

预渲染页面可能需要新的 ISR 缓存。Void 会询问是否启用，并将选择保存为 `routing.isr`。选择 `false` 则会在每次请求时渲染这些页面。在 CI 中，请在部署前设置此选项。现有缓存会保留其 ID。

如果关联时报错提示缺少绑定，请在 `cloudflare` 和 `inference.bindings` 中使用现有 Worker 的绑定名称和资源 ID。重试时请保留 `.void/cloudflare-link.json`。

如果之后要更改由控制台管理的触发器或可见性，请先将当前的 `routes`、`workers_dev` 和 `preview_urls` 添加到配置中。关联前请将 `wrangler.toml` 转为 JSON/JSONC。命名环境需要各自独立的 Void 项目配置。

### 部署过程 {#what-happens-during-deploy}

Void 会创建缺失的资源、构建应用、检查密钥和迁移、上传 Worker、验证就绪状态，然后更新流量和触发器。资源 ID 会保存在 `void.lock.json` 中。

构建或验证失败后，已创建的资源可能仍会保留在你的账号中。首次部署时，请每次只从一台机器运行；随后提交锁文件，再从其他机器或 CI 部署。

使用邮件功能的应用需要将 `email.from` 配置到 `void.config.ts` 中。Void 会在构建前检查域名配置，并在更改前征求确认。请参阅[邮件](/zh/guide/email/domains#your-own-cloudflare-account)。

### 从 CI 部署 {#deploying-from-ci}

按需设置以下 CI 密钥和变量：

| 名称                                             | 何时需要                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                           | 必需。需要 Workers Scripts: Edit 权限、对绑定资源的读取权限，以及对 Void 创建资源所用产品的编辑权限。 |
| `CLOUDFLARE_ACCOUNT_ID`                          | 当令牌可以访问多个账号时。                                                                   |
| `DATABASE_URL`                                   | 创建 PostgreSQL 和 MySQL 资源及执行迁移时。                                                             |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`                   | 当 Worker 没有版本预览 URL 时。使用 `my-team` 或 `my-team.workers.dev`。                           |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | 当 Cloudflare Access 保护就绪检查 URL 时。                                                            |

如需使用邮件功能，请在本地运行 `void email setup --platform cloudflare`，提交 `void.lock.json`，并在 CI 中传入 `--require-email`。令牌还需要 Email Routing Edit 和 Email Sending Edit 权限。

#### Cloudflare Access {#cloudflare-access}

在本地部署到受 Access 保护的 Worker 时，可以使用短期用户会话：

```sh
export CF_ACCESS_TOKEN="$(cloudflared access token --app=https://<worker>.<account>.workers.dev)"
```

Void 使用 Access 凭据执行就绪检查，但不会保存凭据。如果检查被拒绝，部署会失败。此时，首次部署所需的引导版本可能已经在 Access 保护下处于激活状态。

### 数据库和密钥 {#databases-and-secrets}

对于 PostgreSQL 和 MySQL，请向部署进程提供 `DATABASE_URL`。Void 会将其用于 Hyperdrive 和迁移，而不会写入配置。MySQL 的表结构变更可能在报错前已部分生效；请参阅[失败的 MySQL 迁移](/zh/guide/database/mysql#failed-migrations)。

创建 Hyperdrive 需要具有 Hyperdrive 编辑权限的 API 令牌。你也可以在 Cloudflare 中创建它，再将其 ID 添加到 `cloudflare.hyperdrive`；已有绑定可通过浏览器登录使用。

部署表结构变更前，请运行 `void db generate` 并提交迁移文件。Better Auth 表也需要这样处理。支持自定义 D1 迁移目录、迁移记录表和文件匹配模式；如果待应用的文件与已验证的迁移历史不一致，部署会停止。

使用 `void secret put <NAME>` 设置生产环境的服务端值。Void 会保留已有的远程密钥，并在使用身份验证的应用需要时创建 `BETTER_AUTH_SECRET`。本地 `.env` 中的值不会被部署。

### 就绪检查和回滚 {#readiness-and-rollback}

Void 通常会先验证上传的版本，再将流量切换过去。如果就绪检查或触发器更新失败，它会恢复上一次部署。通过 Void 部署前，请先在 Cloudflare 中完成或取消正在进行的渐进式发布。

对于 Cloudflare 无法暂存新版本的现有 Durable Object Worker，请先检查变更，然后运行：

```sh
void deploy --platform cloudflare --atomic
```

若要每次部署都使用此方式，请设置 `deploy: { cloudflare: { mode: 'atomic' } }`。原子部署会先将流量切换到新版本，再执行就绪检查。Durable Object 类迁移无法跨迁移边界回滚。

新 Worker 可能需要先激活首次部署，才能进行就绪检查。如果暂存上传失败，请保留 `.void/cloudflare-candidate.json`，以便在同一份工作副本中重试。

使用以下命令查看或恢复版本：

```sh
void project status
void project rollback [version]
```

Void 会连同代码一起恢复已记录的触发器。没有完整触发器快照的版本会保留当前路由和定时任务。回滚不会撤销数据库迁移。若要撤销 D1 迁移，请使用部署在应用迁移前输出的恢复点运行 [`void db restore`](/zh/reference/cli/database#void-db-restore)；Workers Free 需在 7 天内操作，Workers Paid 则为 30 天内。

#### 支持范围和限制 {#scope-and-limitations}

Void 支持部署原生应用、静态站点、SPA、受支持的 SSG，以及 TanStack Start、React Router、SvelteKit、Nuxt、Analog 和 Astro 的 Cloudflare 构建产物。vinext 适配器仍处于实验阶段。

- 原生应用支持 Void 路由规则。直接部署到 Cloudflare 的框架应用必须通过框架或 Worker 配置重定向、重写、回退和响应头。
- `--skip-build` 适用于已有的静态输出。Worker 应用必须重新构建。
- 不支持 Cloudflare 命名环境。请为每个目标使用独立的 Void 项目配置。
- Sandbox 需要 Workers Paid 和 Docker。套餐和令牌权限要求请参阅 [Sandbox 要求](/zh/guide/sandboxes#deployment)。
- 向任意收件人发送邮件需要 Workers Paid；向已验证收件人发送邮件和接收入站邮件可使用 Workers Free。请参阅[邮件](/zh/guide/email/domains#your-own-cloudflare-account)。
- Node.js、Bun 和 Deno 使用各自的[部署方式](/zh/integrations/nodejs-bun-deno)。

请提交 `void.lock.json` 中的 Durable Object 迁移历史。不要删除已部署的步骤或调整其顺序。

### 管理已部署的应用 {#managing-the-deployed-app}

`void secret`、`void domain`、`void project status|list|logs|rollback` 和远程 `void db` 命令会使用所选账号和 Worker。日志以实时流形式输出。

自定义域名命令会立即更新路由。如果首次部署在 DNS 或 TLS 生效期间超时，请在 Cloudflare 中检查域名，并在 `/__void/ready` 可访问后重试。

`void project delete` 不会删除 Cloudflare 资源。请检查资源归属，并在 Cloudflare 中删除它们。

### 本地开发 {#local-development}

本地 D1、KV 和 R2 绑定使用本地数据。生产资源 ID 会在部署时使用。

连接到 Cloudflare 后，Workers AI 会远程运行，因此开发期间的调用会消耗你账号的额度。开发和预览中的远程绑定使用 `void cloudflare login` 会话；如果设置了 `CLOUDFLARE_API_TOKEN`，则使用该令牌。

### 在你的 Cloudflare 账号上使用 AI {#ai-self-host}

`ai.run()`、`ai.stream()` 和 `ai.image()` 使用你的 Workers AI 绑定。对于提供商模型，请配置 AI Gateway，并将提供商密钥保存为 Worker 密钥：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  ai: { gateway: 'my-gateway' },
});
```

```sh
void secret put OPENAI_API_KEY
```

随后，`ai.provider('openai').fetch(...)` 会使用该网关和密钥。示例请参阅 [AI 指南](/zh/guide/ai)。使用 [AI Gateway 分析](https://developers.cloudflare.com/ai-gateway/)查看账号用量。

### 在你的 Cloudflare 账号上使用 ISR {#isr-self-host}

你可以在全局、按路径或按页面配置[重新验证](/zh/guide/edge/revalidation)。Void 会自动创建缓存。

`revalidate()` 会清除共享存储和当前数据中心的边缘缓存。其他数据中心可能会继续返回缓存响应，直到其缓存有效期结束。尚未渲染过 HTML 的数据中心会实时生成 Pages 数据请求的响应。

每次部署都会使用全新的缓存。
