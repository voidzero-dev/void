---
outline: deep
---

# 项目配置 {#setup}

## `void info` {#void-info}

```sh
void info
void info --json
```

显示每个持久化状态和 WebSocket 定义的源文件、推断或显式指定的名称、Worker 类以及绑定。JSON 输出中的 WebSocket 条目还包含对应路由。此命令在本地运行，无需身份验证，不会发起网络请求或生成文件。

移动已部署的定义前，请将建议的 `name` 复制到 `defineDurableState()`、`defineRoom()` 或 `defineWebSocket()` 中。移动文件后保留此名称，即可保留原有资源。迁移流程（包括 WebSocket 参数重命名）参见[持久化状态](/zh/guide/durable-state#rename-a-file-while-keeping-its-state)和 [WebSockets](/zh/guide/websockets#move-a-route-while-keeping-its-state)。

`void.lock.json` 中没有匹配定义的已记录资源会单独列出。请先确认你移动的是哪个资源，再采用建议的名称。如果 Void 无法建议名称，请先恢复并检查原始源文件，再次移动。

`--json` 返回 `resources` 和 `recordedResources`。当前条目包含 `file`、`definition`、`name`、`nameSource`（`inferred` 或 `explicit`）、`className`、`bindingName`，以及可选的 `route`。已记录条目包含 `className` 和 `bindingName`；有匹配名称时，还会包含 `name` 和 `definition`。

## `void migrate` {#void-migrate}

`void migrate` 将旧版 `void.json` 和根目录的 `wrangler.jsonc` 或 `wrangler.json` 转换为 `void.config.ts`。它也支持由受支持的框架适配器引用的单个根目录 `wrangler*.json(c)` 文件。Void 会将备份保存在 `.void/config-migration/`，在 `void.lock.json` 中记录资源 ID，并更新受支持的适配器，使其使用生成的 Cloudflare 配置。

`.void-wrangler.jsonc` 为 Cloudflare 工具生成，应加入 `.gitignore`；迁移时会添加此条目。请审查并提交 `void.config.ts`、`void.lock.json` 和 `.gitignore`。`void init` 和 `void deploy` 会自动迁移旧版文件。如果项目中存在冲突或多个 Cloudflare 配置，请先解决。在部署到 Cloudflare 前，项目安装的 `void` 包必须与 CLI 版本一致。

## `void init` {#void-init}

```sh
void init [--tsconfig] [--github] [--git | --no-git]
          [--toolchain <name>] [--framework <name>] [--starter <name>] [--deploy <target>]
```

配置新的或已有的 Void 项目。在空目录中，可选择 Vite+ 或 Vite、框架，以及 D1、PostgreSQL、MySQL 或静态页面起始模板。

如果想在不提示确认的情况下生成项目，例如通过脚本或编程 Agent 执行，请通过选项传入所需选择。没有交互式终端时，init 会停止并指出需要提供的选项，而不会发起交互提示。

| 选项          | 可选值                                    |
| ------------- | ----------------------------------------- |
| `--toolchain` | `vite-plus`, `vite`                       |
| `--framework` | `react`, `vue`, `svelte`, `solid`         |
| `--starter`   | `sqlite`, `postgresql`, `mysql`, `static` |
| `--deploy`    | `cloudflare`, `void`, `none`              |

```sh
void init --toolchain vite-plus --framework react --starter sqlite --deploy none
npm create void@latest my-app -- --toolchain vite-plus --framework react --starter sqlite --deploy none
```

Cloudflare 和 Void 平台的配置仍需要交互式登录。没有终端时，请选择 `--deploy none`，之后再运行 `void connect`。

Vite+ 项目通过 `vp install` 安装依赖，无需全局安装 Vite+。Void 会保留现有的包管理器版本和锁文件。未配置包管理器的新 Vite+ 项目会使用 pnpm，但不会固定其版本。

对于已有应用，Void 会补齐缺失的依赖和脚本，并更新 Vite 配置。如果无法编辑配置，它会打印需要添加的片段。

向导还会配置 TypeScript、Agent 指令、环境变量声明和部署目标。可选择 Cloudflare、Void 平台，或跳过部署配置。如果跳过登录，准备好后再运行 `void connect`。参见[快速开始](/zh/guide/quickstart)。

每次运行 init 都会配置编程 Agent。新项目会生成一个最简的 `AGENTS.md`，指向 `node_modules/void/docs/`。对于已有项目，在创建、追加或更新此文件前会提示确认；CI 和非交互式运行不会更改已有项目的指令。Void 会为检测到的 Agent 链接技能。参见[编程 Agent](/zh/integrations/agents)。

如果当前目录不在已有仓库或工作区包中，Void 会询问是否初始化 Git。使用 `--git` 可直接初始化，使用 `--no-git` 可跳过。在 CI 中，必须提供 `--git` 才会初始化。工作区包不接受这两个选项。

通过以下选项运行指定的配置步骤：

| 选项         | 用途                                                           |
| ------------ | -------------------------------------------------------------- |
| `--tsconfig` | 更新 TypeScript 配置，并保留现有设置。                         |
| `--github`   | 创建 GitHub Actions 部署工作流。                               |

这两个选项可以组合使用，并会跳过向导中的其他步骤。编程 Agent 配置仍会执行。如果还需要初始化 Git，请添加 `--git`。

对于 Cloudflare 工作流，请添加 `CLOUDFLARE_API_TOKEN` 仓库密钥。PostgreSQL 和 MySQL 应用还需要 `DATABASE_URL`。

支持 GitHub Actions 的 Void 平台使用短期 OIDC 凭据。运行 `void github connect <project> --repo <owner/repo> --executor github_actions` 授权仓库。核心自托管平台不支持此集成。参见[部署](/zh/guide/deployment#github)。

## `void prepare` {#void-prepare}

```
void prepare
```

生成 Void 的类型和 TypeScript 配置，不启动开发服务器，也不构建应用。可在刚克隆项目后，或在 CI 中进行类型检查前运行。
