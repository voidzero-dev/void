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
