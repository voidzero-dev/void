# Void

Build and deploy full-stack apps with [Vite](https://vite.dev), running on Cloudflare Workers.

Void brings together three open-source tools for you and your coding agents:

- **Void SDK:** Build your server and client together with file-based API routes, server-rendered pages, and typed APIs for databases, storage, and AI. Carry types from database queries to the UI.
- **Void CLI:** Build your app, provision the Cloudflare resources it uses, apply migrations, and deploy with one command. Manage resources, inspect logs, and roll back through the same CLI.
- **Void Platform:** Install a shared deployment environment in your Cloudflare account for your team or customers, with access controls, resource limits, usage reporting, and [connected applications](./docs/en/guide/platform/administration/connected-apps.md) that request user-approved deployments.

The SDK's features are optional and composable. Use React, Vue, Svelte, or Solid for Void pages, or keep a [supported application framework](https://void.cloud/integrations/frameworks/overview) for routing and rendering while Void handles resource APIs, migrations, and deployment.

## Getting Started

Use Node.js 24.21.0 or later. In an empty directory, run:

```sh
npm install -D void
npx void init
npm run dev
```

Vite+ is the default toolchain; setup installs it for you and keeps your existing package-manager configuration. Choose your UI framework and starter, then select Cloudflare to deploy to your account:

```sh
npx void deploy
```

Void builds the app, provisions resources, applies database migrations, and prints your deployed URL. Follow the [Quickstart](https://void.cloud/guide/quickstart) for your first app or to add Void to an existing Vite project.

To deploy to a team platform, run `npx void connect <url>` first, then use the same deploy command. See [Install a Void Platform](https://void.cloud/guide/self-hosted-platform) to host one in your Cloudflare account or customize its open-source runtime.

## Documentation

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.

The [Simplified Chinese guides](./docs/zh/guide/index.md) cover the introduction, quickstart, and supported app types.

See [Multilingual Documentation Maintenance](./docs/README.md) for source layout and translation reviews.

`void init` adds a minimal `AGENTS.md` in new projects and asks before changing instructions in existing projects. It also links bundled skills for detected coding agents.

- [Server routes](https://void.cloud/guide/server-routing) and [pages](https://void.cloud/guide/pages-routing/overview)
- [Database](https://void.cloud/guide/database) and [type safety](https://void.cloud/guide/type-safety)
- [Deployment](https://void.cloud/guide/deployment)
- [Framework integrations](https://void.cloud/integrations/frameworks/overview)
- [API](https://void.cloud/reference/api) and [CLI](https://void.cloud/reference/cli) reference
- [Coding agents](https://void.cloud/integrations/agents)

## Contributing

```sh
git clone https://github.com/voidzero-dev/void.git
cd void
vp install
vp run build:all
```

Use `vp run dev:docs` to preview the docs. See [TESTING.md](./TESTING.md) for verification, [Platform Development](https://void.cloud/guide/platform-development) for platform changes, and [operations](./platform/meta/operations.md) for repository deployments.

## License

MIT
