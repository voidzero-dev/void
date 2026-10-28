---
outline: deep
---

# 密钥与环境变量 {#secrets}

## `void secret list` {#void-secret-list}

```
void secret list [--project <name>]
```

列出已保存部署目标的生产环境密钥名称，不会显示密钥值。直接部署到 Cloudflare 时，会查询 `void.config.ts` 中指定的 Worker；`--project` 仅适用于托管项目。

## `void secret put` {#void-secret-put}

```
void secret put <name> [--project <name>]
void secret put <name=value> [--project <name>]
```

支持以下方式输入值：

- 命令行内指定：`void secret put API_KEY=abcd`
- 交互式提示（TTY）：`void secret put API_KEY`，输入内容会隐藏
- 标准输入：`echo -n "abcd" | void secret put API_KEY`

直接部署到 Cloudflare 时，该值会保存为加密的 Worker 密钥。

## `void secret sync` {#void-secret-sync}

```
void secret sync <file> [--project <name>]
```

从项目目录之外保存的 dotenv 文件上传生产环境服务端值。只包含 `env.ts` 中声明的键，不要加入本地开发凭据或公开的 `VITE_*` 值。

```sh
void secret sync /secure/path/production.env
```

文件中未包含的已有远程密钥会保留。每个条目都必须对应 `env.ts` 中声明的服务端键，且值必须通过校验。

## `void secret delete` {#void-secret-delete}

```
void secret delete <name> [--project <name>]
```

密钥命令使用 `.void/project.json` 中保存的平台。托管项目的选择顺序与部署相同：`--project`、环境变量、已关联项目。直接部署到 Cloudflare 时，不接受 `--project`，而是使用项目根目录中已确定的 Cloudflare 配置。

托管项目正在部署或回滚时，写入和删除密钥会返回可重试的冲突。请等待该操作完成后重试；被拒绝的操作不会更改已保存的密钥。

## 环境变量 schema {#env-schema}

### `void env check` {#void-env-check}

```
void env check [--remote]
```

不带 `--remote` 时，会校验本地开发使用的 `.env` 和 Shell 环境变量。使用 `--remote` 时，会校验构建所在 Shell 中的客户端值，以及远程服务端密钥的名称。如果缺少必填键，或可读取的值无效，命令会以非零状态码退出。

### `void env types` {#void-env-types}

```
void env types
```

根据 `env.ts` 重新生成 `.void/env.d.ts`。通常会在开发服务器启动和 HMR 时自动执行；刚克隆项目后，或需要在非开发环境中更新过期类型时，可以使用此命令。

::: tip 部署时的校验
`void deploy` 会自动执行相同的 schema 校验，并检查远程密钥。缺少任何必填键时，都会拒绝上传，因此部署时无需单独调用 `env check`。
:::

完整指南见[环境变量](/zh/guide/env-vars)。
