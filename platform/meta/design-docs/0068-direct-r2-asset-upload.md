---
title: Direct R2 Asset Upload
status: implemented
---

# Direct R2 asset upload

The CLI uploads asset bytes directly to R2 using short-lived presigned PUT URLs issued by the platform API. It deduplicates uploads by content hash, then sends a manifest-only deployment request. Worker bundles continue through the deployment API.

The API validates asset declarations, checks that required objects exist in the project-scoped R2 store, and publishes the deployment manifest and routing state. Keeping asset bytes out of the final deploy request avoids long multipart uploads through the API Worker.

See [CLI orchestration](../../../packages/void/src/cli/deploy.ts), [upload URL and deployment routes](../../../platform/packages/api/src/routes/deploy.ts), and the [deployment guide](../../../docs/en/guide/deployment.md).
