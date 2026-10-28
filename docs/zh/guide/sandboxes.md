---
outline: deep
---

# 沙箱 {#sandboxes}

使用 Cloudflare Sandbox，可以在服务端代码中运行命令、操作文件并连接服务器。每个沙箱 ID 对应一个隔离的容器。

## 使用要求 {#requirements}

部署到 Cloudflare 需要 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) 和 Containers 访问权限。本地开发，以及需要构建镜像的直接部署，都需要运行 Docker。团队平台的运行时令牌需要 Account / Containers: Edit 和 Account / Cloudchamber: Edit 权限。

## 运行命令 {#run-a-command}

```ts
import { defineHandler } from 'void';
import { getSandbox } from 'void/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  const result = await sandbox.run(['node', '--version']);
  return c.json({
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  });
});
```

从 `void/sandbox` 导入内容，就会启用所需资源。本地开发、直接部署到 Cloudflare 和团队平台使用相同的运行时 API。

## 运行时 API {#runtime-api}

`getSandbox(id, options)` 会取得沙箱，但不会启动它。第一次运行命令、操作文件或请求端口时才会启动容器。ID 长度为 1–63 个字符，默认转换为小写；传入 `normalizeId: false` 可保留大小写。

```ts
import { getSandbox } from 'void/sandbox';

const sandbox = await getSandbox(`user-${user.id}`, {
  inactivityTimeoutMs: 10 * 60 * 1000,
  enableInternet: false,
});
const result = await sandbox.run(['node', '--version'], {
  signal: AbortSignal.timeout(5_000),
});
```

命令以数组形式接收可执行文件和参数。要使用 shell 语法，需显式运行 `['sh', '-c', command]`。执行选项包括 `cwd`，默认值为 `/workspace`，以及 `env`、`user`、`signal`、`pty`、`stdin`、`stdout` 和 `stderr`。

沙箱操作返回 Promise。`run()` 完成后会返回命令退出码，以及 `ArrayBuffer` 类型的 `stdout` 和 `stderr`。超出用量限制时，Promise 会以 [`UsageLimit`](#usage-limits) 错误被拒绝；其他错误也会使 Promise 被拒绝。

`exec()` 完成后返回一个进程对象。等待 `process.output()` 可收集输出和退出码，也可以直接读取流，再等待 `process.exitCode`。等待命令结束，可以让长时间运行的命令在暂停输出时仍保持活动；无人等待的后台命令可能在沙箱空闲后停止。命令成功启动后，等待其完成的操作仍可能因运行时限额而被拒绝。

使用 `stdin: 'pipe'` 可取得可写的输入流。`kill(signal?)` 用于停止进程，`resize(cols, rows)` 用于调整终端大小。

文件操作位于 `sandbox.files` 下：`readFile`、`writeFile`、`stat`、`lstat`、`readDirectory`、`mkdir`、`rename` 和 `remove`。`readFile()` 完成后会返回流式 `Response`，随后可使用 `.text()`、`.arrayBuffer()` 或 `.body`。`writeFile()` 接受文本、二进制数据或字节流。使用相对文件路径时，必须显式指定 `cwd` 选项。

要访问容器内的服务器，调用 `sandbox.fetch(port, new Request(url))` 并等待结果。`sandbox.running()` 用于检查容器是否正在运行，`sandbox.destroy()` 用于停止容器。

在 Cloudflare 原生部署中，`sandbox.fetch()` 也支持 WebSocket 升级请求。从 Worker 处理函数返回它的响应，即可将客户端连接到容器。托管 Void 部署目前不支持 WebSocket 升级。

`getSandbox()` 的选项包括 `inactivityTimeoutMs`，默认十分钟、最长六小时；`enableInternet`，默认为 `false`；以及字符串类型的 `labels`。互联网访问设置和标签会在容器下次启动时生效。`binding` 用于选择自定义原生绑定；托管平台使用已配置的绑定。

需要在两种部署目标上运行的代码，应使用 `getSandbox()`。只有本地环境和 Cloudflare 原生部署支持通过 `c.env.SANDBOX` 直接访问。

## 用量限制 {#usage-limits}

超出沙箱限额时，会抛出 `SandboxLimitError`，它继承自 `void/limits` 的 `UsageLimit`。错误包含 `resource: 'sandbox'`，以及值为 `concurrency` 或 `runtime_budget` 的 `reason`。如果未捕获该错误，Void 路由处理函数和 Pages action 会自动返回结构化的 HTTP 429 响应。

使用 `instanceof UsageLimit` 可以同时处理 AI 和沙箱的用量限制；如果只需处理沙箱限制，则使用 `instanceof SandboxLimitError`：

```ts
import { defineHandler } from 'void';
import { UsageLimit } from 'void/limits';
import { getSandbox } from 'void/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  try {
    const result = await sandbox.run(['node', 'task.mjs']);
    return c.json({ exitCode: result.exitCode });
  } catch (error) {
    if (error instanceof UsageLimit) {
      return error.response({
        message: 'Execution is temporarily unavailable. Try again shortly.',
      });
    }
    throw error;
  }
});
```

保留用户输入，以便重试。超出用量限制后，仍可调用 `running()` 检查状态、停止进程，以及调用 `destroy()`。

## 状态持久化 {#state-persistence}

在同一次部署中，`getSandbox(id)` 会为同一个 ID 选择同一个 Durable Object。Cloudflare 原生部署会跨 Worker 版本保留这一命名空间。托管平台的每次部署都有自己的命名空间；回滚到保留的部署时，会重新连接到该部署的命名空间。

文件、运行中的进程和监听中的服务器都只能在容器存活期间保留。容器可能因空闲、崩溃或重启而停止。需要持久保留的数据应存入数据库、KV 或 R2。在 Void 平台上删除项目，会同时移除其 Durable Objects 和容器。

## 配置 {#configuration}

默认环境为 Debian Trixie 上的 Node.js 26。托管平台部署使用 Cloudflare 托管的 Node.js 镜像。

需要自定义镜像或容器规格时，使用 `void.config.ts`：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  sandbox: {
    image: './Dockerfile.sandbox',
    platformImage: 'registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>',
    instanceType: 'standard-1',
  },
});
```

绑定名称、镜像设置和容器规格见[配置参考](/zh/reference/config#sandbox)。

自定义镜像必须包含与 Void 已安装的 Sandbox SDK 版本匹配的辅助程序。SDK 镜像提供这个二进制文件，但本身不是可直接运行的环境：

```dockerfile
FROM node:26.12.1-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.2 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

对于托管平台，将自定义镜像推送到该平台账号的 Cloudflare 镜像仓库，并将 `platformImage` 设置为通过摘要固定版本的镜像引用。如果 `image` 已是 Cloudflare 镜像仓库引用，它也会作为默认的 `platformImage`。不支持外部镜像仓库和可变标签。详见 [Cloudflare 镜像管理指南](https://developers.cloudflare.com/containers/guides/image-management/#push-images-to-the-cloudflare-registry)。

## 部署 {#deployment}

`void deploy --platform cloudflare` 会构建原生镜像，并将沙箱与应用一同部署。连接到 Void 平台后运行 `void deploy`，会应用该平台的沙箱并发和运行时限额。
