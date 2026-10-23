# `packages/void/test/e2e`

Gated live-account end-to-end tests. These run real Cloudflare operations against the selected
account and skip when credentials are absent. They never delete remote resources.

## `cloudflare-deploy-live.test.ts`

Deploys an isolated copy of `playground/spa` (D1 + KV + cron) through
`void deploy --platform cloudflare`. It checks HTTP responses, D1 and KV reads/writes, the registered
cron, and a second deployment that preserves resource IDs and test data.

The first run creates missing D1 and KV resources. Later runs reuse the same Worker and the actual
IDs of its named test database and namespace. The generated config, lockfile, and build output stay
in the ignored fixture directory printed by the test. The tracked playground is not modified.

### Prerequisites

The suite skips unless both credential variables are set. Credentialed runs also require an explicit,
stable namespace reserved for this suite in the selected test account.

| Environment variable     | Purpose                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `VOID_E2E_CF_TOKEN`      | Cloudflare API token with Workers Scripts: Edit, D1: Edit, and Workers KV Storage: Edit.        |
| `VOID_E2E_CF_ACCOUNT_ID` | Test account ID.                                                                                |
| `VOID_E2E_NAMESPACE`     | Short lowercase account-local namespace, such as a team or operator name. Reuse it across runs. |

The token's Edit permissions include the reads needed to discover existing resources. Cron triggers
are published with the Worker. This fixture does not require paid-only services.

The account needs an existing workers.dev subdomain with its TLS certificate ready. If Cloudflare
Access blocks the test hostname, configure a public test hostname or an explicit **Bypass + Everyone**
policy for `void-e2e-cf-deploy-<namespace>.<account-subdomain>.workers.dev`. **Allow + Everyone** still
requires authentication. Keep unrelated account policies unchanged.

### Running it

Build the CLI, then supply credentials through the environment:

```sh
vp run build:core

VOID_E2E_CF_TOKEN=... VOID_E2E_CF_ACCOUNT_ID=... VOID_E2E_NAMESPACE=my-team \
  vp test run packages/void/test/e2e
```

Use a short namespace so the Worker and its derived names fit Cloudflare's naming limits. Never
select production resource names. The suite reserves:

- Worker: `void-e2e-cf-deploy-<namespace>`
- D1: `void-e2e-cf-deploy-<namespace>-db`
- KV: `void-e2e-cf-deploy-<namespace>-kv`

Runs with the same account and namespace must be serialized, including across local checkouts.
Different operators should use different stable namespaces. Random values are used only for test
records and KV keys; resources and test data are retained after successful and failed runs.

Any eventual cleanup is a separate, manually reviewed operation against exact resource IDs. Do not
add teardown deletion to this suite. See [the live-testing guidance](../../../../TESTING.md#native-cloudflare-live-e2e-tests).

### In CI

The dedicated `live-e2e` job runs only on direct pushes to `main` in the canonical repository. Its
`cloudflare-e2e` GitHub Environment supplies `VOID_E2E_CF_TOKEN` and `VOID_E2E_CF_ACCOUNT_ID`; a
preflight fails if either credential is empty. The job uses the stable `ci` namespace and a concurrency
group to serialize updates to that account's test resources.

The GitHub Environment must allow deployments from `main` only. This server-side branch policy
keeps its credentials away from pull-request code even if a PR changes the workflow. Other test jobs
receive no Cloudflare credentials and skip the live suite.
