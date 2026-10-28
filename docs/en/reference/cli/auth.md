---
outline: deep
---

# Connections and Authentication {#connect}

```sh
void connect
void connect platform.example.com
void connect --platform cloudflare
void connect --platform void
```

Connect a project to its deployment destination. With no arguments, choose Cloudflare or a Void platform interactively. A URL selects a Void platform directly. `--platform void` offers saved platforms and an option to enter another URL.

You can use a hostname: `void connect platform.example.com` connects over HTTPS. Loopback hosts (`localhost`, `127.0.0.1`, and `[::1]`) default to HTTP, so use `void connect localhost:8787` for a local platform. This also works in the interactive prompt. Include a scheme to override the default, for example `void connect https://localhost:8787`.

For Cloudflare, Void signs in through the browser when needed, selects an accessible account, and saves `cloudflare.account_id` in `void.config.ts` or resolved state in `void.lock.json`. It shares this setup with `void init`. An existing account selection is preserved; conflicting or inaccessible account settings must be resolved before continuing.

For a Void platform, Void checks the connection and signs you in through your browser when needed. It saves credentials in your system keychain separately for each platform.

The deployment preference is saved in `.void/project.json`. Connecting to another Void platform preserves an existing project link; the CLI explains when that link or an environment override still selects a different destination. Use `void project link` to explicitly choose a project. Cloudflare selection also retains existing Void project metadata so you can switch back later.

In a non-interactive shell, supply a URL or explicit target. Cloudflare requires usable credentials and an unambiguous account (`CLOUDFLARE_ACCOUNT_ID` when needed). For a Void platform, provide `VOID_TOKEN` with a matching `VOID_API_URL`, or reuse a valid origin-scoped keychain session. Use `void connect <url> --no-login` to save the verified connection without authenticating; this option is only available for Void platforms.

## Authentication {#authentication}

`void auth login`, `void auth status`, and `void auth logout` use the destination
saved for the current project by `void init` or `void connect`. If no destination
is saved, interactive commands let you choose Cloudflare or a connected Void
platform. In a non-interactive shell, pass `--platform cloudflare|void` or use
the explicit `void cloudflare` and `void account` commands. Choosing a destination
for authentication does not change the project's deploy target.

## Void platform account {#void-platform-account}

### `void account login` {#void-account-login}

Browser login through one of the platform's currently enabled methods. The token is saved in the operating-system keychain, scoped to the platform origin. Login fails closed when no keychain is available instead of writing the token to a plaintext file; headless environments use `VOID_TOKEN` from their secret manager.

Connect to a platform with `void connect <url>` before logging in. If an older project link has no platform URL, connect and run `void project link` to select its project again.

Set `VOID_API_URL` alongside `VOID_TOKEN` to identify the platform that issued it.
Both the URL and token are required for environment-based authentication, and the
URL must already be connected. In a fresh CI environment, run
`void connect "$VOID_API_URL" --no-login` before deploying. To use a platform's
saved login instead, unset `VOID_TOKEN`.

This is optional if you already completed auth during `void connect` or the interactive `void init` flow.

### `void account link [connection-id]` {#void-account-link-connection-id}

Link another enabled login method to your current account. Sign in again if your
session is no longer recent, complete the additional provider's browser login,
and confirm the displayed identity. With no connection ID, choose an enabled
method interactively. The optional dashboard exposes the same flow in **Account**.

### `void account logout` {#void-account-logout}

Removes saved credentials.

### `void account whoami` {#void-account-whoami}

Prints your current login.

### `void account token` {#void-account-token}

Copies your human auth token to the system clipboard. It is intended for
interactive troubleshooting and remains subject to login-method revocation. Do
not combine it with a Cloudflare Access service token for CI; machine Access
proof cannot turn a human Void token into an automation identity. Create a
project-scoped credential with `void project token create` instead.

## Cloudflare authentication {#cloudflare-authentication}

Use Void's Cloudflare commands to sign in and manage credentials. No separate Cloudflare CLI is needed. Browser credentials are encrypted and protected by your system keychain.

- `void cloudflare login` — sign in through your browser or switch Cloudflare users.
- `void cloudflare status` — show your identity, credential source, accessible accounts, and deployment account.
- `void cloudflare logout` — remove the local browser session.

Interactive `void connect --platform cloudflare`, `void init`, and `void deploy --platform cloudflare` invoke the same login flow automatically when necessary. Non-interactive CI must set `CLOUDFLARE_API_TOKEN`.

Signing in changes the browser session, not `account_id` in the project configuration. Check `void cloudflare status` after switching users; if the new user cannot access the pinned account, resolve the project target separately before deploying.

An API token or global API key pair in the environment takes precedence over browser credentials. Explicit browser login stops with the names of these overrides; remove them from that shell before signing in. `status` reports the active credential source, and `logout` warns if environment credentials remain active. Explicit browser login requires an interactive terminal; automatic deployment checks continue to reuse valid sessions.
