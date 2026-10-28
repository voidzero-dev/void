# 部署产物 {#deployment-artifacts}

在 Node.js 中使用 `void/deploy`，可以在没有平台凭据的环境中，将已构建的 Void 应用、SPA 或静态站点整理为托管平台的部署产物。

在应用的隔离环境中，以托管模式构建应用：

```sh
VOID_DEPLOY_BUILD=1 VOID_DEPLOY_PROJECT_ID=artifact npm run build
```

这些值用于选择与平台兼容的构建方式。`artifact` 是构建标记，不是已有项目的 ID 或凭据；目标项目会在发布审批时选择。

```ts
import { prepareDeployArtifact } from 'void/deploy';

const { artifact, assets } = await prepareDeployArtifact('/path/to/app');
```

`artifact` 包含部署清单、按内容寻址的资源元数据，以及应用需要 Worker 时以 base64 编码的 Worker 模块。SPA 和静态站点仅包含资源，使用与 `void deploy` 相同的应用检测、输出目录和路由配置。`assets` 将资源 URL 路径映射到以 base64 编码的字节内容。请求[发布审批](/zh/guide/platform/administration/connected-apps)期间，请保持该结果不变。

准备过程仅打包已有的构建输出，不会执行构建、连接平台、创建资源或部署。支持 Void 的 Cloudflare Worker 构建、SPA 和静态站点。Node 目标、Pages 的 `output: 'static'`、远程数据、部署时预渲染，以及 Sandbox 和 Live 资源，仍需使用常规的 `void deploy` 流程。

准备过程应与应用构建在同一隔离环境中运行。应用配置和构建插件会执行项目代码，平台凭据应留在发布服务器上。

## Cloudflare Build Output {#cloudflare-build-output}

::: warning 实验性功能
`prepareCfBuildOutput` 遵循 Cloudflare 的 Build Output 格式草案，其选项和生成目录可能随 Void 版本变化。
:::

使用 `prepareCfBuildOutput`，将已有的 Cloudflare Worker 构建转换为用后可清理的 Cloudflare Build Output 目录：

```ts
import { prepareCfBuildOutput } from 'void/deploy';

const prepared = await prepareCfBuildOutput('/path/to/app/dist/server', {
  projectRoot: '/path/to/app',
  mode: 'staging',
});
if (!prepared) {
  throw new Error('The Worker build could not be prepared.');
}

try {
  // Inspect or pass prepared.directory to your Cloudflare publication workflow.
} finally {
  await prepared.dispose();
}
```

传入包含生成的 `wrangler.json` 的 Worker 输出目录，例如 `dist/ssr`、`dist/rsc` 或 `dist/server`。如果应用由 Cloudflare 构建工具构建，则应传入项目根目录，其中的原生 Build Output 位于 `.cloudflare/output/v0`。准备过程会复制模块和资源，不改动输入内容。原生输出中的模块类型、辅助 Worker、Container 声明和构建元数据都会保留。此过程不会创建资源、上传 Worker 或启用部署。通过本地 Dockerfile 构建的容器镜像只存在于构建它的 Docker 环境中，因此需要从该环境发布。

| 选项          | 说明                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId`   | 构建必须面向的 Cloudflare 账号。如果构建中的账号不同，则返回 `null`。省略时，保留构建已有的账号；原来未设置时仍不设置。 |
| `mode`        | Vite 构建模式。原生输出保留构建时的模式，传入不同的值会返回 `null`。其他输出默认为 `production`。 |
| `projectRoot` | 包含 `package.json` 及已安装依赖的应用目录，默认为输入目录。 |

结果包含 `directory`、可选的 `assetsDirectory`（指向输入资源），以及异步的 `dispose()` 方法。使用后务必清理结果。不支持的构建配置会返回 `null`。如果目录中没有 Worker 构建、Worker 模块缺失或无效，或资源符号链接指向资源目录之外，则会抛出错误。
