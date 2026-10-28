---
outline: deep
---

# 远程开发 {#remote-development}

默认情况下，Void 通过 [Miniflare](https://miniflare.dev/) 在本地提供 D1、KV 和 R2。开启远程模式后，本地代码可以直接访问已部署到 Void 平台的项目资源，方便你使用现有数据进行测试或排查问题。

你无需修改应用代码，`db.select()`、`env.KV.get()` 等调用就会使用远程已部署的资源。写入操作会影响真实数据，因此应尽量使用预发布环境的项目。

## 准备工作 {#prerequisites}

开启远程模式前，需要完成以下步骤：

1. 使用 `void connect <url>` 连接团队平台；需要登录时，命令会引导你完成登录。
2. 使用 `void project link` 关联项目，并至少部署一次，确保相应资源已经创建。

## 开启远程模式 {#enabling-remote-mode}

### 在 `void.config.ts` 中配置（持续生效） {#in-void-config-ts-persistent}

```json
{
  "remote": true
}
```

### 通过环境变量开启（仅本次生效） {#via-environment-variable-one-off}

```bash
VOID_REMOTE=1 vite dev
```

即使 `void.config.ts` 中设置了 `"remote": true`，`VOID_REMOTE=0` 也会关闭远程模式。

## 支持的绑定 {#supported-bindings}

| 绑定 | 本地模式（默认） | 远程模式 |
| --- | --- | --- |
| D1 | 通过 Miniflare 使用本地 SQLite | 远程 D1 数据库 |
| KV | 使用本地文件存储的 KV | 远程 KV 命名空间 |
| R2 | 使用本地文件存储的 R2 | 远程 R2 存储桶 |
| AI | 始终通过代理访问 | 始终通过代理访问 |

无论使用本地还是远程模式，AI 请求都会使用平台账号及其额度。AI 没有本地模拟器。

## 确认远程模式已开启 {#checking-remote-mode}

开启远程模式后，开发服务器启动时会输出：

```
[void] Remote bindings active
         DB      → remote D1
         KV      → remote KV
         STORAGE → remote R2
```

## 使用限制 {#limitations}

- **网络延迟：** 每次绑定调用都会发起网络请求，响应可能比本地开发慢。
- **R2 分片上传：** 远程模式不支持 `createMultipartUpload()` 和 `resumeMultipartUpload()`。
- **R2 范围读取和条件读取：** 远程模式下，如果将请求头作为 `range` 或 `onlyIf` 传给 `get()`，这些请求头会被忽略，返回的仍是完整对象。例如，即使请求包含 `Range` 或 `If-None-Match`，`get(key, { range: request.headers, onlyIf: request.headers })` 也会返回完整对象。如果 `range` 或 `onlyIf` 是明确指定字节范围或读取条件的对象，例如 `{ offset: 0, length: 100 }` 或 `{ etagMatches: etag }`，`get()` 则会抛出错误。
- **R2 条件写入：** `put(..., { onlyIf })` 要求平台和项目部署均已更新。前置条件不满足时返回 `null`。
- **R2 元数据与列表选项：** 自定义元数据、HTTP 元数据，以及带有 `delimiter`、`startAfter` 或 `include` 的 `list()`，都要求先更新项目部署。否则，带有这些选项的 `list()`，以及写入 `contentType` 以外元数据的 `put()`，都会抛出错误。
- **D1 导出：** 远程模式不支持 `db.dump()`。
- **D1 批量操作：** `db.batch()` 要求平台和项目部署均已更新。
