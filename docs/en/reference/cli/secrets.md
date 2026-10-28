---
outline: deep
---

# Secrets and Environment {#secrets}

## `void secret list` {#void-secret-list}

```
void secret list [--project <name>]
```

List production secret names for the saved target. Secret values are never printed. Direct Cloudflare targets query the Worker named in `void.config.ts`; `--project` is hosted-only.

## `void secret put` {#void-secret-put}

```
void secret put <name> [--project <name>]
void secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `void secret put API_KEY=abcd`
- prompt (TTY): `void secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | void secret put API_KEY`

On a direct Cloudflare target, the value is stored as an encrypted Worker secret.

## `void secret sync` {#void-secret-sync}

```
void secret sync <file> [--project <name>]
```

Upload production server values from a dotenv file stored outside your project. Include only keys declared in `env.ts`; leave out local development credentials and public `VITE_*` values.

```sh
void secret sync /secure/path/production.env
```

Existing remote secrets absent from the file are kept. Every entry must be a server key declared in `env.ts`, and its value must pass validation.

## `void secret delete` {#void-secret-delete}

```
void secret delete <name> [--project <name>]
```

Secret commands use the platform saved in `.void/project.json`. Hosted project resolution follows the same order as deploy (`--project`, env var, linked project). Direct Cloudflare targets reject `--project` and use the pinned root Cloudflare config.

On hosted projects, secret writes and deletes return a retryable conflict while a deployment or rollback is in progress. Wait for that operation to finish and retry; the rejected operation leaves the stored secret unchanged.

## Env Schema {#env-schema}

### `void env check` {#void-env-check}

```
void env check [--remote]
```

Without `--remote`, validate `.env` plus the shell for local development. With `--remote`, validate build-shell client values and the remote server-secret names. Exits non-zero if a required key is missing or a readable value is invalid.

### `void env types` {#void-env-types}

```
void env types
```

Regenerate `.void/env.d.ts` from `env.ts`. Normally happens automatically on dev server start and HMR; use this command after a fresh clone or to refresh stale types in non-dev contexts.

::: tip Deploy validation
`void deploy` runs the same schema validation automatically (with remote secrets) and refuses to upload if any required key is missing — no need to call `env check` separately when deploying.
:::

See [Environment Variables](../../guide/env-vars.md) for the full guide.
