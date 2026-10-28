---
outline: deep
---

# Schema 与 CI {#schema-and-ci}

## 修改平台 Schema {#changing-the-platform-schema}

Schema 定义位于 `platform/packages/api/src/schema.ts`。修改后生成迁移：

```sh
vp run --filter @voidcloud/api db:generate
```

提交前，请审阅生成的 SQL 和迁移日志。已发布的迁移只能追加。升级应用新迁移时，旧 Worker 可能仍在处理请求，因此 schema 变更必须与旧代码保持兼容。

`platform/packages/api/drizzle/compatibility.json` 记录哪些旧版运行时已经通过新 schema 的兼容性验证。只有测试确认兼容后，才能添加对应的兼容关系。运行时构建会检查迁移文件与已记录的 schema 历史是否一致。

## 运行时产物约定 {#runtime-artifact-contract}

`@void/platform` 的 `./installer` 导出包含安装清单、资源命名、发现协议、Worker 配置和可部署的打包产物。平台源码位于 `platform/packages/`。

运行时产物包含迁移 SQL、迁移日志和回滚兼容性清单。Drizzle 编写迁移时使用的快照保留在源码树中。

## Fork 中的 CI {#ci-in-a-fork}

无需凭据的测试工作流在 fork 中使用 GitHub 托管的运行器。它们会构建并测试工作区，无需 Void Cloud 账号、令牌或部署权限。

如果 fork 已有发布的平台版本，请将仓库变量 `VOID_PLATFORM_PRODUCTION_REF` 设置为该版本不可变的 40 位提交 SHA。此后，平台相关的拉取请求会创建该版本的数据库，写入有代表性的用户、项目和经过加密的 Secret 记录，再应用提议的迁移。检查会验证已有数据，并使用旧运行时连接升级后的 schema 运行。可变的分支名或标签名会被拒绝。

如果没有显式指定 SHA，必需的兼容性检查会使用最近一次成功部署到 `Prod` 或 `VOID_PLATFORM_PRODUCTION_ENV` 所指定环境的 GitHub 部署。这些检查需要读取部署历史的权限；如果找不到已完成的部署，就会停止。推进生产分支不会改变已选定的基准。fork 中调用平台 CI 的工作流，必须同时授予 `deployments: read` 和 `contents: read`。

上游仓库还包含部署 Void Cloud 和发布官方 npm 包的工作流。fork 应围绕构建出的 CLI 和 `platform upgrade --runtime` 配置自己的发布工作流；所需输入见[源码构建 CI 示例](/zh/guide/platform/development/runtime#deploying-source-builds-from-ci)。生产凭据应保存在受保护的环境中，且只允许相应的发布引用访问。
