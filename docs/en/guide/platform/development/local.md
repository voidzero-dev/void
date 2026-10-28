---
outline: deep
---

# Local Development

## Setting Up the Repository

Clone your fork and install the workspace dependencies with Vite+:

```sh
git clone https://github.com/your-org/void.git
cd void
vp install
vpr install:void-dev
void-dev --help
```

Use the Node.js version recorded in `.node-version`.

`install:void-dev` builds the CLI, shared packages, and platform runtime, then makes this checkout's built CLI globally available as `void-dev`. Public packages export their built files, so run `vp run build:core` after later source changes to refresh the alias. The installer refuses to replace an unrelated global command. Remove only this checkout's alias with `vpr uninstall:void-dev`. The commands on these development pages run from the repository root.

## Finding the Implementation

| Directory                                            | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/void`                                      | Framework, application runtime, and CLI                              |
| `packages/platform`                                  | Installer contracts, packaged Workers, and platform migrations       |
| `packages/deploy-core`, `packages/deploy-cloudflare` | Shared deployment contracts and Cloudflare upload code               |
| `platform/packages/api`                              | Users, projects, deployments, provisioning, and administrator API/UI |
| `platform/packages/dispatch`                         | Application routing and static assets                                |
| `platform/packages/proxy`                            | AI, remote bindings, and revalidation                                |
| `platform/packages/email-gateway`                    | Inbound mail routing and tenant delivery                             |
| `platform/packages/tail`                             | Runtime log ingestion                                                |
| `platform/packages/dashboard`                        | Dashboard source and local UI components in `ui/`                    |

The `@voidcloud/*` names identify workspace implementation packages. Their `private: true` flags prevent publishing those packages to npm. Deployable core Workers are bundled into the public `@void/platform` package.

The core installer creates the API, dispatch, proxy, tail, and email gateway Workers. The dashboard and managed GitHub build services are available in the source tree but are not included in that installation. Adding an optional service requires its infrastructure, bindings, authentication, and capability configuration together.

## Running the API Locally

Start a local PostgreSQL server and make `psql` and `pg_isready` available on your path. Then create the development database, apply its migrations, and seed an administrator:

```sh
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev:admin
```

The command disables the optional build containers, so basic API and admin work
does not require Docker. To develop managed builds, install Docker and run the
API with containers enabled.

Open `http://localhost:8787/admin/`. Setup writes the API's local database connection and development authentication bypass to `platform/packages/api/.dev.vars`. It configures `platform/packages/dashboard/.env` for the separate dashboard. Both files are ignored by Git. Production installations get separate credentials through the installer.

The API's development bypass lets you work on the browser admin UI without setting up OAuth. Operator CLI sessions still require administrator authentication; they do not use the browser bypass.

`dev:admin` watches source files and automatically reloads the browser after edits. Keep it running while working on the admin dashboard's React components and styles; no platform deployment is needed. The setup includes sample users, projects, and deployments for trying each view locally.

## Running the Dashboard Locally

The dashboard is a separate source app. After API setup, start it in another terminal:

```sh
vp run --filter @voidcloud/dashboard dev
```

Setup points the dashboard's local `.env` at the API you started:

```dotenv
API_URL=http://localhost:8787
SITE_DOMAIN=apps.example.com
```

Open the Vite URL and choose **Dev login (local API)**. That button appears for a localhost API and uses the local development sign-in endpoint.

You can also point the dashboard at an API that you operate. If Cloudflare Access protects that API, install `cloudflared` and opt into the dashboard's local token helper with matching origins:

```dotenv
API_URL=https://platform.example.com
CF_ACCESS_APP_URL=https://platform.example.com
SITE_DOMAIN=apps.example.com
```

The helper refreshes an Access session before the dev server starts. Human
dashboard requests require the user's Access session as well as their Void login;
a service token does not represent that user. Service-token pairs are for scoped
machine operations. This is dashboard development configuration; Access
credentials are separate from platform login credentials.

For a deployed dashboard, bind its `API` service to your platform API, configure
`DASHBOARD_URL` on both the dashboard and API, and include that exact dashboard origin in the
platform's Access protection application. The dashboard passes the browser's
company identity to the API using that service binding. Its login page shows
the platform's currently enabled methods, and **Account** supports adding an
additional login identity.

## Testing Changes

Run tests for the area you changed while developing:

```sh
vp test run platform/packages/api/test/integration/operator-auth.test.ts
vp run check
```

Before preparing a release, build the packages and run the complete checks:

```sh
vp run build:all
vp run check
vp lint
vp run lint:platform
vp fmt --check
vp test run
vp run build:docs
```

Platform integration tests use their local test database by default. To test against PostgreSQL, set `VOID_TEST_DATABASE_URL` to a disposable database: these tests clear tables between cases.

To exercise a deployed application, deploy a disposable copy of `playground/kitchen-sink` and pass its URL as `SMOKE_URL` to the smoke test described in `platform/scripts/kitchen-sink-smoke-test.md`. That test creates and removes application data.
