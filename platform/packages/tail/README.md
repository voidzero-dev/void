# @voidcloud/tail

Tail consumer for deployed user workers.

## Behavior

- Receives Cloudflare tail events from the dispatch namespace.
- Parses worker script names into:
  - `projectKey`: `user-{slug}`
  - `deployId`: `dpl_*` when present
- Writes one Analytics Engine row per trace event.
- A request routed through the dispatch Worker arrives twice: through the
  dispatch Worker's consumer and through the user Worker's own consumer.
  Cloudflare delivers each copy in a separate invocation, so this Worker writes
  both and the API's log queries collapse identical rows.

Versioned deploys use script names like `user-my-app-dpl_abc123`. Legacy unversioned names like `user-my-app` are still accepted for older deployments.

## Analytics Engine Schema

| Slot         | Content                   |
| ------------ | ------------------------- |
| `indexes[0]` | `projectKey`              |
| `blobs[0]`   | outcome                   |
| `blobs[1]`   | serialized logs           |
| `blobs[2]`   | serialized exceptions     |
| `blobs[3]`   | request URL               |
| `blobs[4]`   | request method            |
| `blobs[5]`   | response status as string |
| `blobs[6]`   | deploy ID or `""`         |
| `doubles[0]` | event timestamp           |
| `doubles[1]` | response status as number |

## Source Layout

```text
src/index.ts              # tail() handler + parseScriptName()
test/parse-script-name.test.ts
```

## Configuration and Deployment

For a self-hosted installation, `void platform install` configures the tail
consumer and its Analytics Engine binding, and `void platform upgrade` deploys
changes from the packaged runtime. Dataset and Worker names belong to that
installation.

The checked-in Wrangler environments describe the existing Void Cloud deployment.
Its dispatch configuration references this Worker through `tail_consumers`, so
maintainers deploy tail before dispatch. See the
[Void Cloud operations note](../../meta/operations.md) for that deployment and
[Platform Development](../../../docs/en/guide/platform-development.md) to build your
own runtime.

This Worker has no public HTTP surface. It stores events in Analytics Engine;
the API provides log queries to the CLI and administrator UI.
