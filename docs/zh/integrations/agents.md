---
outline: deep
---

# 配合编程 Agent 使用 Void {#using-void-with-coding-agents}

`void init` 会在初始化项目时配置编程 Agent：

```sh
npx void init
```

新项目会获得一个精简的 `AGENTS.md`，介绍 Void 并说明文档的位置。
对于已有项目，Void 会在创建、追加或更新 `AGENTS.md` 之前征求你的同意，
并保留 Void 部分以外的现有指令。拒绝后文件保持不变；在 CI 和非交互式运行中，
Void 会跳过对已有项目指令的修改。

完整的 Markdown 文档随包发布，位于 `node_modules/void/docs/`。
项目配置请从 `guide/quickstart.md` 开始，命令说明请查看 `reference/cli.md`。
即使没有链接技能，Agent 也可以直接阅读这些文档。

## 技能 {#skills}

技能为 Agent 指明完成任务所需的命令和文档。它们链接到已安装的 `void` 包，因此其中的指引与应用使用的版本一致。

Void 提供两个技能：

- **`void`：** 应用开发所需的命令和文档。
- **`migrate-vite-cloudflare-to-void`：** 用于将已有的 `@cloudflare/vite-plugin` 应用迁移到 Void 的技能。

`void init` 检测到受支持 Agent 的配置时，会自动链接技能。例如，Claude Code 使用
`.claude/skills/`，Codex 使用 `.agents/skills/`。这些技能使用应用中已安装的文档，
使指引与其 Void 版本保持一致。没有本地安装时，全局安装的技能可以使用其 Void 包中的文档。
如果未检测到 Agent，指令仍会直接指向随包附带的文档。
