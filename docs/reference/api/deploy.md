# Deployment artifacts

Use `void/deploy` from Node.js to prepare a built Void app, SPA, or static site for a managed platform deployment without platform credentials.

Build the app in managed mode inside its isolated environment:

```sh
VOID_DEPLOY_BUILD=1 VOID_DEPLOY_PROJECT_ID=artifact npm run build
```

These values select a platform-compatible build. `artifact` is a build marker, not an existing project ID or a credential; the target project is selected during publish approval.

```ts
import { prepareDeployArtifact } from 'void/deploy';

const { artifact, assets } = await prepareDeployArtifact('/path/to/app');
```

`artifact` contains the deployment manifest, content-addressed asset metadata, and base64 Worker modules when the app needs a Worker. SPAs and static sites contain only assets, using the same app detection, output directory and routing configuration as `void deploy`. `assets` maps asset URL paths to base64 bytes. Keep this result immutable while requesting [publish approval](/guide/platform/administration/connected-apps).

Preparation packages existing build output; it does not build, contact a platform, provision resources, or deploy. It supports Void Cloudflare Worker builds, SPAs, and static sites. Node targets, Pages `output: 'static'`, remote data, deploy-time prerendering, Sandbox, and Live resources require the normal `void deploy` workflow instead.

Run preparation inside the same isolated environment as the app build. App configuration and build plugins execute project code; keep platform credentials on the publishing server.

## Cloudflare Build Output

::: warning Experimental
`prepareCfBuildOutput` follows Cloudflare's draft Build Output format. Its options and the prepared directory can change between Void releases.
:::

Use `prepareCfBuildOutput` to convert an existing Cloudflare Worker build into a disposable Cloudflare Build Output directory:

```ts
import { prepareCfBuildOutput } from 'void/deploy';

const prepared = await prepareCfBuildOutput('/path/to/app/dist/server', { mode: 'staging' });
if (!prepared) {
  throw new Error('The Worker build could not be prepared.');
}

try {
  // Inspect or pass prepared.directory to your Cloudflare publication workflow.
} finally {
  await prepared.dispose();
}
```

Pass the Worker output directory that contains a generated `wrangler.json`, such as `dist/ssr`, `dist/rsc`, or `dist/server`. When Cloudflare's build tooling built the app, pass the project root that contains its native Build Output at `.cloudflare/output/v0` instead. Preparation copies modules and assets without changing that input. Native output keeps its module types, auxiliary Workers, Container declarations, and build metadata. Preparation does not provision resources, upload a Worker, or activate a deployment. Container images built from a local Dockerfile exist only in the Docker environment that built them, so publish from that environment.

| Option      | Description                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId` | Cloudflare account the build must target. A different account in the build returns `null`. When omitted, the build's account is kept or left unset.  |
| `mode`      | Vite build mode. Native output keeps the mode it was built with, and a different value returns `null`. For other output it defaults to `production`. |

The result contains `directory`, an optional `assetsDirectory` pointing to the input assets, and an asynchronous `dispose()` method. Always dispose the result after use. Unsupported build configuration returns `null`. A directory without a Worker build, a missing or invalid Worker module, or an asset symlink outside the asset directory throws an error.
