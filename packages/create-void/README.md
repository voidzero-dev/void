# create-void

Create a full-stack Vite app with [Void](https://void.cloud), ready for local development and deployment to Cloudflare.

## Getting Started

Use Node.js 24.21.0 or later:

```sh
npm create void@latest my-app
cd my-app
npm run dev
```

Choose a project name with 1–63 lowercase letters, numbers, or dashes. It must start and end with a letter or number; underscores, spaces, dots, and paths are not supported.

Choose Vite+ or Vite, then React, Vue, Svelte, or Solid. Pick a D1, PostgreSQL, MySQL, or Static Pages starter. The wizard installs dependencies and sets up TypeScript and coding agents; choose Cloudflare to deploy to your account, or connect to a team platform.

When you're ready to deploy:

```sh
npx void deploy
```

## Documentation

Follow the [Quickstart](https://void.cloud/guide/quickstart) to explore your new app. For an existing Vite app, install `void` and run `npx void init`.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
