---
outline: deep
---

# GitHub 与构建 {#github}

通过 GitHub 部署适用于**任何** Void 登录方式，包括 Google、GitHub 或其他 SSO。首次连接 GitHub 时，Void 会将 GitHub 身份关联到当前账号。这是一次性操作，与登录方式无关，不会创建第二个账号。

项目级 `github` 和 `build` 命令与部署命令使用相同的项目解析顺序：先使用 `[project]` 参数或 `--project`，再使用 `VOID_PROJECT`，最后使用已关联的项目（`.void/project.json`）。

## `void github link` {#void-github-link}

```
void github link
```

通过浏览器将当前登录的 Void 账号关联到 GitHub。`void github install` 会在需要时自动执行此操作。

::: warning 已有的 GitHub 登录关联
一个 GitHub 身份只能属于一个 Void 账号。如果它已关联到其他账号，请登录那个 Void 账号，或授权另一个 GitHub 身份。
:::

## `void github install` {#void-github-install}

```
void github install
```

在浏览器中打开 GitHub App 安装页面。如果账号尚未关联 GitHub 身份，`void github install` 会先自动执行 GitHub 关联（通过浏览器授权），再继续安装。安装后，请运行 `void github connect`，将仓库关联到项目。

## `void github installations` {#void-github-installations}

```
void github installations
```

列出与账号关联的全部 GitHub App 安装。每个条目都包含 `[id: <installation_id>]`，供非交互式使用时传给 `--installation`。

## `void github join` {#void-github-join}

```
void github join
```

通过浏览器加入已有的组织安装。在交互式终端中，`void github connect` 可以自动执行此操作。如果需要进行非交互式配置，请先在本地运行 `join`。

需要已登录的 Void 账号，且平台已启用组织安装共享。使用 `void github installations` 查找安装 ID。

## `void github connect` {#void-github-connect}

```
void github connect [project] [options]
```

将 GitHub 仓库连接到 Void 项目以启用自动部署。每次向配置的分支推送时，Void 都会自动构建并部署项目。

需要 GitHub 授权时，CLI 会打开浏览器。如果没有可用的安装，请运行 `void github install`。

**选项**

| 选项                  | 说明                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `--project <name>`    | 项目名称（位置参数的别名）                                                        |
| `--installation <id>` | GitHub App 安装 ID（有多个安装时必填）                                           |
| `--repo <owner/repo>` | 仓库完整名称；除非安装仅授权了一个仓库，否则必填                                  |
| `--branch <name>`     | 用于部署的分支；**非交互模式下必填**                                             |
| `--executor <type>`   | 构建执行器：`container`（默认）或 `github_actions`                               |
| `--workflow <path>`   | 获授权的部署工作流文件，默认为 `.github/workflows/void-deploy.yml`                |

选择 `container` 以使用平台构建，或选择 `github_actions` 以使用部署工作流。CLI 会提示选择执行器；使用 GitHub Actions 时，还会提示选择工作流文件。传入对应选项可跳过这些提示。

工作流必须是 `.github/workflows/` 下的 `.yml` 或 `.yaml` 文件。只有该工作流可以获取项目的 OIDC 部署令牌。建议使用专门的部署工作流。

在 CI 中，请提供项目和分支；如果无法自动选择安装和仓库，也需提供它们。组织连接需要先在本地浏览器中完成仓库授权。

```
void github connect my-app \
  --installation 42 \
  --repo owner/my-app \
  --branch main
```

只能连接 GitHub 账号有权访问的仓库。

每个项目只能有一个 GitHub 连接。对已连接的项目运行 `void github connect` 会失败。要连接其他仓库，请先运行 `void github disconnect`。

## `void github update` {#void-github-update}

```
void github update [project] [options]
```

更改已有连接的分支、执行器或工作流。要更改仓库，请先断开连接，再重新连接。

**选项**

| 选项                | 说明                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `--project <name>`  | 项目名称（位置参数的别名）                                       |
| `--branch <name>`   | 新的部署分支                                                     |
| `--executor <type>` | 新的构建执行器：`container` 或 `github_actions`                  |
| `--workflow <path>` | 新的获授权部署工作流文件（位于 `.github/workflows/` 下）          |

CLI 会以当前值作为默认值，提示选择新设置。在 CI 中，请至少传入 `--branch`、`--executor` 或 `--workflow` 中的一项。

```
void github update my-app --executor github_actions
```

## `void github status` {#void-github-status}

```
void github status [project]
```

显示已连接的仓库、分支、执行器和工作流。容器构建不使用工作流文件。

**选项**

| 选项               | 说明                                             |
| ------------------ | ------------------------------------------------ |
| `--project <name>` | 项目名称（位置参数的别名）                       |

```
void github status my-app
```

## `void github disconnect` {#void-github-disconnect}

```
void github disconnect [project]
```

断开项目与 GitHub 仓库的连接，停止自动部署。移除连接前，会取消该项目所有正在进行的构建。如果项目没有连接，会报告这一情况并成功退出。要让项目使用其他仓库，请先断开连接，再运行 `void github connect`。

移除任何内容前都会请求确认。传入 `--yes` 可跳过提示；非交互式 shell（CI）中没有可回答的提示，因此**必须**提供 `--yes`。

**选项**

| 选项               | 说明                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `--project <name>` | 项目名称（位置参数的别名）                                        |
| `--yes`            | 跳过确认提示（非交互式 shell 中必填）                              |

```
void github disconnect my-app --yes
```

## 构建 {#build}

检查通过 GitHub 部署时的构建。

### `void build logs` {#void-build-logs}

```
void build logs [build] [--follow] [--output <file>] [--project <slug>]
```

流式查看、持续跟踪或下载**容器**构建的日志。不提供 `[build]` 参数时，使用项目最近一次构建。

| 选项                     | 用途                                                                      | 默认值 |
| ------------------------ | ------------------------------------------------------------------------- | ------- |
| `--follow`, `-f`         | 实时跟踪：持续轮询，直到构建完成且最终日志已捕获。                         | 关闭    |
| `--output <file>`, `-o`  | 将日志写入文件，而不是标准输出（跟踪期间会追加写入）。                     | 标准输出 |
| `--project <slug>`, `-p` | 目标项目。                                                               | 已关联的项目 |

运行在 **GitHub Actions** 上的构建将日志保留在 GitHub。此命令会打印 Actions 运行 URL，而不会流式输出日志。容器构建仅保留最后 10,000 行日志。

跟踪模式会等待平台确认最终的日志尾部。如果平台无法确认，请升级平台运行时，或不带 `--follow` 读取已保留的日志。如果最终日志尾部未完整获取，两分钟后会报错；可以重试以重新获取。

示例：

```
void build logs                     # print the latest build's logs
void build logs -f                  # follow the latest build until it finishes
void build logs bld_123 -o build.log  # download a specific build's logs
```
