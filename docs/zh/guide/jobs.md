---
outline: deep
---

# 定时任务 {#cron-jobs}

将定时任务放在 `crons/` 中。每个文件声明一个 cron 表达式和一个处理函数，Void 会在部署时配置调度计划。

## 任务文件 {#job-files}

在 `crons/**/*.ts` 中创建文件（也支持 `.mts`、`.js` 和 `.mjs`）。

每个任务文件必须导出：

- `export const cron = "<expression>"`（也可以是表达式数组）
- 一个默认导出的处理函数（建议使用 `defineScheduled` 包装）

例如：

```ts
// crons/hourly-heartbeat.ts
import { defineScheduled } from 'void';

export const cron = '0 * * * *';

export default defineScheduled(async (controller, env) => {
  await env.KV.put('jobs:last-heartbeat', controller.scheduledTime.toString());
});
```

### 多个调度计划 {#multiple-schedules}

同一个任务文件可以导出 cron 表达式数组：

```ts
// crons/cleanup.ts
import { defineScheduled } from 'void';

export const cron = ['0 * * * *', '30 * * * *'];

export default defineScheduled(async (controller, env) => {
  // Runs at :00 and :30 every hour
});
```

## `defineScheduled` {#definescheduled}

使用 [`defineScheduled()`](/zh/reference/api/handlers#definescheduled-handler) 包装处理函数，可以为调度事件、环境和执行上下文提供类型。

多个任务使用同一个 cron 表达式时，每次触发会分别执行一次。Void 会等待所有匹配的任务完成，并报告失败情况。以 `_` 开头的文件和目录会被忽略。

## 本地开发 {#local-development}

本地开发时，调度计划不会自动触发。你可以向 Void 的开发端点发送请求来测试任务：

```
POST /__void/scheduled
Content-Type: application/json
{ "cron": "<expression>", "scheduledTime": <unix_ms> }
```

将 `cron` 设为任务导出的某个表达式。调用成功时会返回 `{ "ok": true }`。

此端点需要本地开发触发令牌。开发服务器启动时，Void 会输出一条包含当前令牌、可以直接复制使用的 curl 命令。

```bash
curl -X POST http://localhost:5173/__void/scheduled \
  -H "Content-Type: application/json" \
  -H "x-void-dev-trigger: <printed-token>" \
  -d '{"cron":"0 * * * *","scheduledTime":'"$(date +%s000)"'}'
```

此端点适用于原生 Void 应用和受支持的框架。框架中的任务在适配器的开发运行时中执行，使用该适配器提供的绑定。

## 部署行为 {#deployment-behavior}

原生调度事件无需手动提供 HTTP 令牌。对于框架部署，发送到 `/__void/scheduled` 的 HTTP 请求必须携带匹配的 `x-void-internal` 令牌：托管平台会提供其代理令牌，你也可以显式配置 `CRON_SECRET` 用于手动调用。令牌缺失或不匹配时，会返回 `401`，不会执行任务。

在 Void 平台上，每个项目最多可以使用 100 个不同的 cron 表达式和 1,000 个调度计划（任务导出的每个表达式计为一个调度计划）。多个任务共享同一个表达式时，该表达式在表达式数量限制中只计一次。部署到自己的 Cloudflare 账号时，则适用 Cloudflare 的 [Cron Trigger 限制](https://developers.cloudflare.com/workers/platform/limits/)。
