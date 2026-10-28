# @voidcloud/dashboard

Optional authentication frontend for a Void platform, built as a React Pages
mode app. The administrator UI is served by the API Worker.

## Architecture

- **React Pages mode** - `voidPlugin()` + `voidReact()`, SSR with client hydration.
- **Auth** - enabled platform login methods via the API's `/auth/login` flow. The JWT is
  stored in an httpOnly cookie (`void_token`). Middleware validates the token with
  `GET /me`.
- **Styling** - Dashboard-local CSS, fonts, assets, and React components in `ui/`,
  with Astryx's neutral theme for buttons, stacks, and the account menu.

## Pages

| Route            | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `/login`         | Currently enabled platform login methods  |
| `/auth/callback` | Exchanges the login response for a token  |
| `/`              | Minimal authenticated confirmation page   |
| `/account`       | Links another login method to the account |
| `/logout`        | Clears cookie, redirects to login         |

## Local Development

Start with an API you run locally. From the repository root, with PostgreSQL
running and its client tools on your path:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

In another terminal:

```sh
vp run --filter @voidcloud/dashboard dev
```

Setup creates an ignored API `.dev.vars` file and a dashboard `.env` file.
The dashboard's `platform/packages/dashboard/.env` points to the local API:

```dotenv
API_URL=http://localhost:8787
SITE_DOMAIN=apps.example.com
```

Open the Vite URL and choose **Dev login (local API)**. That path requires the
API's explicit development bypass and the dashboard's login nonce. Operator
CLI authentication remains separate from the browser development bypass.

To use an API that you operate, set `API_URL` to its public origin and
`SITE_DOMAIN` to its application domain. If Cloudflare Access protects it,
set `CF_ACCESS_APP_URL` to that same HTTPS origin. The local token helper uses
`cloudflared` to refresh its Access session before Vite starts; automation can
supply `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` instead.

See [Platform Development](../../../docs/en/guide/platform-development.md) for the
full setup and source-runtime workflow. The core platform installer does not
install the dashboard; running this app locally does not add it to an installation.

## Standalone Deployment

Use a source checkout to deploy a dashboard for an installed platform. Make a
separate copy in `playground-local/my-dashboard`, keeping the app’s source,
assets, package manifest and TypeScript configuration. Exclude local environment
files, dependencies and generated output. Give the copied package a unique
private name and keep its `build: vp build` script. In the copied Vite config,
keep `voidPlugin()` and `voidReact()`, and remove the local API
`persistTo` option.

Replace the copied `cloudflare` configuration with your deployment settings:

| Setting                        | Value                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `name`                         | An unused dashboard Worker name in your account                                                    |
| `account_id`                   | The installed API Worker’s Cloudflare account ID                                                   |
| `compatibility_date`           | `2026-10-01`                                                                                       |
| `compatibility_flags`          | `['nodejs_compat']`                                                                                |
| `assets`                       | `{ directory: 'dist/client' }`                                                                     |
| `routes`                       | `[{ pattern: 'dash.example.com', custom_domain: true }]`, using a hostname in your Cloudflare zone |
| `workers_dev` / `preview_urls` | `false` for a dashboard served only at its custom hostname                                         |
| `services`                     | `[{ binding: 'API', service: '<installed-api-worker-name>' }]`                                     |
| `vars.API_URL`                 | The installed API’s public HTTPS origin                                                            |
| `vars.DASHBOARD_URL`           | The dashboard’s HTTPS origin, such as `https://dash.example.com`                                   |
| `vars.SITE_DOMAIN`             | The installation’s application domain, such as `apps.example.com`                                  |

From the repository root, run `vp install` and `vp run build:core`. Configure the
API’s accepted dashboard origin using the
[optional dashboard instructions](../../../docs/en/guide/platform/installation/domains.md#optional-dashboard).
Then deploy from the copied app directory with the public Void CLI:

```sh
vp exec void deploy --platform cloudflare
```

The `API` binding sends server requests to your installed API, while
`API_URL` supplies browser login URLs. Open the dashboard’s `/login` page once
deployment reports readiness. If Access protects the platform, configure its
coverage for the dashboard origin as described in the installation guide.

## Source Layout

```text
lib/
  api.ts                    # Typed authentication API fetch helpers
ui/
  components/               # Dashboard header and footer
  styles/                   # Design tokens, reset, and shell styles
  assets/                   # Void logos and bundled social icons
  fonts/                    # APK Protocol, KH Teka Mono, and Inter
middleware/
  01.auth.ts                # void_token validation through /me
pages/
  layout.tsx                # Shared navigation progress
  _layouts/dashboard.tsx    # Authenticated shell with logout
  login.tsx                 # Enabled login method buttons
  login.server.ts           # Builds configured login URLs
  account.tsx               # Account linking form
  account.server.ts          # Starts the identity-linking flow
  logout.tsx
  logout.server.ts          # Cookie clear + redirect
  index.tsx                 # Authenticated confirmation page
  index.server.ts           # Session user from middleware
  auth/
    callback.tsx
    callback.server.ts      # OAuth callback token/code exchange
```

## Inter license

The `ui/fonts/inter-*.woff2` files are copyright (c) 2016 The Inter Project
Authors and are distributed under the SIL Open Font License 1.1. The full
copyright notice and license are included in
[`ui/fonts/Inter-LICENSE.txt`](./ui/fonts/Inter-LICENSE.txt). Keep that file with
copies of the Inter fonts. This notice applies specifically to Inter.
