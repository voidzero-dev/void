---
outline: deep
---

# First Deployment

Open your platform's API URL in a browser to see its welcome page, CLI connection instructions, and a link to the administrator dashboard. Share this URL with teammates so they can connect to your platform.

First verify the new platform and sign in with the administrator login method selected during setup:

```sh
void platform status
void platform auth login
void platform system health
```

Administrator login is separate from the credentials used to deploy apps. In a new or unlinked Void app directory, connect using the installed API URL and deploy your first project:

```sh
void connect void-company-api.example.workers.dev
void deploy --platform void --project my-first-app
```

`void connect` validates the platform and signs you in when needed. Confirm project creation when deploy asks. To use a project that already exists, run `void project link` instead. An app already linked to another platform keeps its existing destination; use a fresh app directory for your first test.

Once accepted by the platform, a deployment continues independently of the CLI connection. The CLI reconnects automatically after a connection failure. Use `void project status` to inspect a deployment after closing the CLI, or `void project cancel` to request cancellation.

The CLI stores login credentials in your system keychain, separately for each platform URL. With no URL, `void connect` offers Cloudflare or a Void platform; `void connect --platform void` offers saved platforms and an option to enter another URL.

For CI, create a bounded, project-scoped deploy credential while signed in as
the project owner:

```sh
void project token create --name ci --expires-in 30
```

Store the printed `VOID_TOKEN` and `VOID_API_URL` in the CI secret manager, then
run `void connect "$VOID_API_URL" --no-login` before deploying in each fresh CI
environment. Project files do not replace this connection step. CI cannot answer
the project prompt, so choose the project before `void deploy`: set `VOID_PROJECT`,
pass `--project <slug>`, or commit `.void/project.json` from `void project link`.
New apps ignore `.void` in `.gitignore`; to commit the link, replace that line
with `.void/*` and `!.void/project.json`. Rotate with `void project token renew <id>` and revoke with
`void project token revoke <id>`. A human login token is not a CI credential.

If Cloudflare Access protects the platform, Access proof and the project
credential are both required; the service token does not grant Void user or
operator authority. A deploy that uses prerendering or remote bindings calls
both the API and proxy, so store `VOID_ACCESS_CREDENTIALS` in the CI secret
manager with entries for both exact HTTPS origins. Include both entries even
when the same admitted service-token pair is used for both origins:

```json
{
  "https://void-company-api.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  },
  "https://void-company-proxy.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  }
}
```

`VOID_ACCESS_ORIGIN` can scope credentials to one origin only; setting it to
the API origin does not authorize proxy requests.

Use these commands to inspect connections and installations:

```sh
void platform list
void platform use [id]
void platform status [id]
```

## Managing Access

After installation, sign in as the first administrator. For a teammate who uses GitHub, add their login to the signup allowlist:

```sh
void platform auth login
void platform signup allow github teammate
```

Void shows the proposed access change and asks you to confirm it. Once approved, `teammate` can connect to the platform's API URL and sign in with GitHub.

To allow email addresses, domains, or OIDC identities, or to open signup, see [Giving People Access](/guide/platform/administration/access#giving-people-access).

Your administrator session lasts for one hour. Use it to inspect users, projects, logs, and platform health. The [Platform Administration guide](/guide/platform-administration) walks through those workflows, previews, and automation. You can also open `<API origin>/admin/login` to use the browser admin UI.

### Protect Project Hostnames with Zero Trust

After installation, an administrator can require Cloudflare Access on new project hostnames while allowing each project owner or project administrator to opt out. This is independent of Access login and protection for the platform API itself, and it needs its own Cloudflare API token. See [Project Zero Trust](/guide/platform/administration/zero-trust) for the requirements, setup command, and recovery.
