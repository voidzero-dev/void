---
outline: deep
---

# Remote Development

Void normally uses local D1, KV, and R2 through [Miniflare](https://miniflare.dev/). Remote mode lets you run local code against a project deployed to your Void platform, for example to test with existing data or investigate an issue.

Calls such as `db.select()` and `env.KV.get()` use the deployed resources without changing your application code. Writes affect real data, so use a staging project when possible.

## Prerequisites

Before enabling remote mode, you need:

1. Connect to your team's platform with `void connect <url>`. It signs you in when needed.
2. Link a project with `void project link`. Deploy it at least once so its resources exist.

## Enabling Remote Mode

### In `void.config.ts` (persistent)

```json
{
  "remote": true
}
```

### Via environment variable (one-off)

```bash
VOID_REMOTE=1 vite dev
```

`VOID_REMOTE=0` disables remote mode even if `void.config.ts` has `"remote": true`.

## Supported Bindings

| Binding | Local (default)            | Remote              |
| ------- | -------------------------- | ------------------- |
| D1      | Local SQLite via Miniflare | Remote D1 database  |
| KV      | Local file-backed KV       | Remote KV namespace |
| R2      | Local file-backed R2       | Remote R2 bucket    |
| AI      | Always proxied             | Always proxied      |

AI requests use your platform’s account and allowance in both local and remote mode. There is no local AI simulator.

## Checking Remote Mode

When the dev server starts with remote mode active, it prints:

```
[void] Remote bindings active
         DB      → remote D1
         KV      → remote KV
         STORAGE → remote R2
```

## Limitations

- **Network latency:** each binding call makes a network request, so responses may be slower than local development.
- **R2 multipart uploads:** `createMultipartUpload()` and `resumeMultipartUpload()` are not supported in remote mode.
- **R2 range and conditional reads:** in remote mode, `get()` ignores request headers passed as `range` or `onlyIf` and returns the whole object. For example, `get(key, { range: request.headers, onlyIf: request.headers })` returns the whole object when the request has a `Range` or `If-None-Match` header. `get()` throws when `range` or `onlyIf` is an object that asks for a byte range or a condition, such as `{ offset: 0, length: 100 }` or `{ etagMatches: etag }`.
- **R2 conditional writes:** `put(..., { onlyIf })` requires an updated platform and project deployment. Failed preconditions return `null`.
- **R2 metadata and list options:** custom metadata, HTTP metadata, and `list()` with `delimiter`, `startAfter`, or `include` require an updated project deployment. Without one, `list()` with these options and `put()` with metadata other than `contentType` throw an error.
- **D1 dump:** `db.dump()` is not supported in remote mode.
- **D1 batches:** `db.batch()` requires an updated platform and project deployment.
