---
outline: deep
---

# Sandboxes

Use a Cloudflare Sandbox to run commands, work with files, and connect to servers from server code. Each Sandbox ID selects an isolated container.

## Requirements

Cloudflare deployments require [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Containers access. Run Docker for local development and direct deployments that build an image. A team platform's runtime token needs Account / Containers: Edit and Account / Cloudchamber: Edit.

## Run a command

```ts
import { defineHandler } from 'void';
import { getSandbox } from 'void/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  const result = await sandbox.run(['node', '--version']);
  return c.json({
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  });
});
```

Importing from `void/sandbox` enables the required resources. Local development, direct Cloudflare deployments, and team platforms share the same runtime API.

## Runtime API

`getSandbox(id, options)` resolves a Sandbox without starting it. The first command, file operation, or port request starts the container. IDs contain 1–63 characters and are lowercased by default; pass `normalizeId: false` to preserve case.

```ts
import { getSandbox } from 'void/sandbox';

const sandbox = await getSandbox(`user-${user.id}`, {
  inactivityTimeoutMs: 10 * 60 * 1000,
  enableInternet: false,
});
const result = await sandbox.run(['node', '--version'], {
  signal: AbortSignal.timeout(5_000),
});
```

Commands take an executable and arguments as an array. For shell syntax, explicitly run `['sh', '-c', command]`. Execution options include `cwd` (default `/workspace`), `env`, `user`, `signal`, `pty`, `stdin`, `stdout`, and `stderr`.

Sandbox operations return promises. `run()` resolves with `stdout` and `stderr` as `ArrayBuffer`s and the command's exit code. Usage limits reject with [`UsageLimit`](#usage-limits); other failures reject normally.

`exec()` resolves with a process. Await `process.output()` to collect its output and exit code, or read the streams and await `process.exitCode`. Waiting for completion keeps a long command active during pauses in its output; unattended background commands can stop when the Sandbox becomes idle. A runtime limit can reject completion after a command has successfully started.

Use `stdin: 'pipe'` for a writable input stream. `kill(signal?)` stops a process, and `resize(cols, rows)` resizes its terminal.

File operations live under `sandbox.files`: `readFile`, `writeFile`, `stat`, `lstat`, `readDirectory`, `mkdir`, `rename`, and `remove`. Await `readFile()` to receive a streaming `Response`, then use `.text()`, `.arrayBuffer()`, or `.body`. `writeFile()` accepts text, binary data, or a byte stream. Relative file paths require an explicit `cwd` option.

To reach a server inside the container, await `sandbox.fetch(port, new Request(url))`. `sandbox.running()` checks whether the container is running; `sandbox.destroy()` stops it.

On native Cloudflare deployments, `sandbox.fetch()` also supports WebSocket upgrade requests. Return its response from your Worker handler to connect the client to the container. WebSocket upgrades are currently unavailable on managed Void deployments.

`getSandbox()` options include `inactivityTimeoutMs` (default ten minutes, maximum six hours), `enableInternet` (default `false`), and string `labels`. Internet access and labels take effect on the next container start. `binding` selects a custom native binding; managed platforms use the configured binding.

For code that runs on both deployment targets, use `getSandbox()`. Direct access through `c.env.SANDBOX` is available only on local and native Cloudflare deployments.

## Usage limits

Sandbox limits reject with `SandboxLimitError`, which extends `UsageLimit` from `void/limits`. The error includes `resource: 'sandbox'` and a `reason` of `concurrency` or `runtime_budget`. Void route handlers and Pages actions automatically send a structured HTTP 429 when the error is left uncaught.

Use `instanceof UsageLimit` to optionally handle both AI and Sandbox limits, or `instanceof SandboxLimitError` for Sandbox-specific handling:

```ts
import { defineHandler } from 'void';
import { UsageLimit } from 'void/limits';
import { getSandbox } from 'void/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  try {
    const result = await sandbox.run(['node', 'task.mjs']);
    return c.json({ exitCode: result.exitCode });
  } catch (error) {
    if (error instanceof UsageLimit) {
      return error.response({
        message: 'Execution is temporarily unavailable. Try again shortly.',
      });
    }
    throw error;
  }
});
```

Keep user input available so it can be retried. Checking `running()`, stopping a process, and `destroy()` remain available after a usage limit.

## State persistence

`getSandbox(id)` selects the same Durable Object for that ID within a deployment. Native Cloudflare deployments preserve that namespace across Worker versions. Each managed platform deployment has its own namespace; rolling back to a retained deployment reconnects to that deployment's namespace.

Files, running processes, and listening servers last only as long as the container. It can stop after inactivity, crash, or restart. Save anything you need to keep in your database, KV, or R2. Deleting a project on a Void platform removes both its Durable Objects and containers.

## Configuration

The default environment provides Node.js 26 on Debian Trixie. Managed platform deploys use Cloudflare's managed Node.js image.

Use `void.config.ts` when you need a custom image or container size:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  sandbox: {
    image: './Dockerfile.sandbox',
    platformImage: 'registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>',
    instanceType: 'standard-1',
  },
});
```

See the [configuration reference](../reference/config.md#sandbox) for binding names, image settings, and container sizes.

Custom images must include the helper matching Void's installed Sandbox SDK version. The SDK image supplies this binary, but is not a runnable environment itself:

```dockerfile
FROM node:26.12.1-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.2 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

For a managed platform, push your custom image to that platform account's Cloudflare registry and set `platformImage` to its digest-pinned reference. If `image` is already a Cloudflare registry reference, it also becomes the default `platformImage`. External registries and mutable tags are not supported. See [Cloudflare's image management guide](https://developers.cloudflare.com/containers/guides/image-management/#push-images-to-the-cloudflare-registry).

## Deployment

`void deploy --platform cloudflare` builds native images and deploys the Sandbox alongside the application. `void deploy` on a connected Void Platform applies the platform's Sandbox concurrency and runtime limits.
