# @voidcloud/email-gateway

The platform's dedicated inbound email Worker. Its source is packaged with the
core Workers in `@void/platform`; the installer deploys it and enables platform
email when the shared sender domain and mail zone are configured. See the
[installation credentials](../../../docs/en/guide/platform/installation/credentials.md)
for those inputs.

The gateway accepts mail on the shared domain and authenticated relays from
customer-zone ingress Workers. It asks the API to resolve each exact domain
assignment, then dispatches bounded deliveries to the active application Worker.
The API keeps durable receipt and operation records; the proxy handles outbound
mail. `GET /health` exposes the gateway protocol version, and destination
confirmation links pass through the gateway to the API.

For a self-hosted installation, use `void platform install` or `upgrade` rather
than deploying this package on its own. The repository's Wrangler configuration
and deployment scripts target Void Cloud production and staging. Their rollout
order and required bindings and secrets are described in the
[operations runbook](../../meta/operations.md#email).

Run the focused unit tests from the repository root with:

```sh
vp test run platform/packages/email-gateway/test/unit
```
