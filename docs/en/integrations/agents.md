---
outline: deep
---

# Using Void with Coding Agents

`void init` sets up coding agents as part of project initialization:

```sh
npx void init
```

New projects get a minimal `AGENTS.md` explaining Void and where to read its docs.
In an existing project, Void asks before creating, appending to, or updating
`AGENTS.md`. It preserves your instructions outside the Void section. Declining
keeps the file unchanged; CI and non-interactive runs skip changes to existing
projects' instructions.

The complete Markdown docs ship at `node_modules/void/docs/`. Start with
`guide/quickstart.md` for setup and `reference/cli.md` for commands. Agents can
read them directly, even without a linked skill.

## Skills

Skills point your agent to the commands and docs it needs for the task. They link to the installed `void` package, so the guidance matches the version your app uses.

Void ships two skills:

- **`void`:** commands and docs for app development.
- **`migrate-vite-cloudflare-to-void`:** migration skill for converting existing `@cloudflare/vite-plugin` apps to Void.

Skills are linked automatically by `void init` when it detects a supported
agent's configuration. For example, Claude Code uses `.claude/skills/` and Codex
uses `.agents/skills/`. The skills use the app's installed docs so their guidance
matches its Void version. Globally installed skills can use the docs in their
Void package when there is no local installation. If no agent is detected, the
instructions still point directly to the bundled docs.
