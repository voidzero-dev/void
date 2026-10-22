import {
  MIGRATION_CLASSIFIER_VERSION,
  validateManifestShape,
  isSandboxRegistryImage,
} from '@void/deploy-core';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { type Context } from 'hono';
import { paginatedR2Delete, type AssetManifestEntry } from '../assets.ts';
import { verifyOAuthDeployment, OAuthError } from '../auth/oauth.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import {
  getProject,
  getDeployment,
  createDeployment,
  updateDeploymentStatus,
  updateProjectType,
  getActiveDeployment,
  setActiveDeployment,
  markDeploymentRetained,
  getBuild,
  ACTIVE_BUILD_STATUSES,
} from '../db.ts';
import {
  assertDeploymentExecutionAuthority,
  deploymentInputModule,
  deploymentInputPrefix,
  deploymentReceiptResponse,
  dispatchDeploymentOperation,
  findDeploymentOperation,
  getDeploymentOperation,
  installationDeploymentAdmissionClosed,
  prepareDeploymentInput,
  recordUploadedDeploymentInput,
  uploadedDeploymentInput,
  uploadedWorkerInputProblem,
  type DeploymentInput,
} from '../deployment-execution.ts';
import {
  getSharedEmailRecipientReadiness,
  reconcileSharedEmailRecipient,
} from '../email/shared-recipient-service.ts';
import type { ApiEnv } from '../env.ts';
import { checkCliVersionOrRespond } from '../middleware/cli-version.ts';
import { createDeployLogger, type DeployLogger } from '../observability/logger.ts';
import { resolvePlanLimits } from '../plans.ts';
import { ProjectAccessDeniedError, projectAccessErrorBody } from '../project-access.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import { assertManagedSandboxEntitlement } from '../provisioning/sandbox-controller.ts';
import { requestRotationIfReplacingUntrustedCode } from '../proxy-token-rotation.ts';
import { requireProjectRouteCapability } from '../routes/project-access.ts';
import { deploymentOperations } from '../schema.ts';
import {
  SUPPORTED_MANIFEST_VERSIONS,
  type DeployManifest,
  type Deployment,
  type Project,
} from '../types.ts';
import { blobWorkerModule, type WorkerModule } from '../worker-upload.ts';
import { zeroTrustNotReadyMessage } from '../zero-trust/errors.ts';
import { resolveProjectZeroTrustRouting } from '../zero-trust/routing.ts';
import {
  PROJECT_DELETING_ERROR_MESSAGE,
  ConcurrentDeployError,
  assertBoundBuildStillActive,
  SUPERSEDED_BUILD_ERROR_MESSAGE,
} from './guards.ts';
import { runDeploymentPipeline } from './pipeline.ts';
import {
  requireActiveDeployAccess,
  cutoverIntentKey,
  cutoverReadyKey,
  cutoverCompensatedKey,
  parseCutoverMarker,
  resolvePersistedDeploymentType,
  databaseTimestampMs,
  CUTOVER_RECOVERY_STALE_MS,
  type CutoverMarker,
  replayDeploymentCutover,
  clearProjectExternalState,
} from './recovery.ts';
import {
  assertPersistedDeploymentServingAssetsExist,
  StaticAssetDisappearedError,
} from './serving-assets.ts';
import {
  MAX_UPLOAD_URLS_BATCH,
  MAX_JSON_DEPLOY_BODY_BYTES,
  HEX_32_REGEX,
  decodeBase64ToBytes,
  MAX_WORKER_FILE_BYTES,
  moduleContentType,
  workerFilesError,
  workerInputProblem,
  type WorkerInput,
} from './shared.ts';

const WORKER_UPLOAD_CLAIMED_MESSAGE =
  'this Worker upload belongs to another deployment; run the deploy again';

/**
 * JSON-mode (manifest-only) deploy handler — direct-to-R2 asset upload flow.
 *
 * Operates on a JSON request body. The CLI uploads asset bytes directly
 * to R2 via presigned PUTs (issued by the `/deploy/upload-urls` endpoint)
 * BEFORE calling this handler, so the request body carries only:
 *   - `manifest` (DeployManifest, must declare `assetManifestVersion: 2`)
 *   - `assetManifest` (path → { blake3, md5, size })
 *   - `source`, `commit`, `repositoryUrl`, `commitUrl`, `gitRef`, `preflight`
 *   - for WfP deploys, either `workerInput` (the id and module list of a
 *     Worker upload the CLI made through `/deploy/worker-upload-urls`) or,
 *     from older CLIs and connected apps, `workerFiles` (base64-encoded
 *     module bytes). Static-only deploys send neither.
 *
 * The bytes for declared assets MUST already be in `STATIC_ASSETS_R2` under
 * `assets/${projectId}/${blake3}`; the deploy verifies them before it
 * proceeds and fails on a missing hash.
 *
 * For static deploys, every asset's serving-manifest entry is `!{hash}` —
 * direct-to-R2 always lands in R2. For WfP deploys, asset bytes are fetched
 * back from `STATIC_ASSETS_R2` to populate the in-memory `assetsByHash` map
 * that `uploadAssetBuckets` consumes — server-internal R2-to-CF traffic
 * bypasses the user's request pipe, which is the whole point of the
 * direct-to-R2 flow.
 */
export async function handleManifestOnlyDeploy(context: Context<ApiEnv>): Promise<Response> {
  // Hono's `context.req.param('id')` types as `string | undefined` when called
  // from a non-route-typed context (we receive `Context<ApiEnv>` rather
  // than the route-typed callback Hono synthesises for `app.post`). The
  // route literal is `/:id/deploy`, so this is always a string at
  // runtime — narrow by hand. The ApiEnv route registry guarantees the
  // path matched.
  const projectId = context.req.param('id') as string;
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  let project = access.project;
  // Scoped deploy tokens (aud:'deploy') are pinned to a single project. Reject
  // any attempt to use one against a different project. Full api tokens leave
  // deployScope unset and skip this guard.
  const deployScope = context.get('deployScope');
  if (deployScope && deployScope !== projectId) {
    return context.json(
      {
        error: 'forbidden',
        message:
          'This deploy credential belongs to a different project. Use a credential issued for the project you want to deploy.',
      },
      403,
    );
  }
  // A scoped deploy token may carry the build it was minted for. Reject it once
  // that build is no longer active (e.g. superseded/cancelled by a newer push or
  // run), so a stale runner can't deploy an older commit after being superseded.
  // Tokens without a build claim (full-API tokens, CI credential tokens) skip this.
  const deployBuild = context.get('deployBuild');
  if (deployBuild) {
    const build = await getBuild(context.get('db'), deployBuild);
    if (!build || !ACTIVE_BUILD_STATUSES.includes(build.status)) {
      return context.json(
        {
          error: 'forbidden',
          message:
            'This build is no longer active. Start a new build to deploy the current version.',
        },
        403,
      );
    }
  }
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz so a stale CLI hitting a
  // missing/foreign/deleting project still gets the more specific
  // 404/403/410 first. The multipart sniff inside the helper is
  // header-only — it does not read the request body, so calling it
  // here does not interfere with the streaming JSON parse below.
  const versionReject = checkCliVersionOrRespond(context);
  if (versionReject) {
    return versionReject;
  }
  try {
    await requireNormalizedProject(context.get('db'), project);
  } catch (error) {
    if (error instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: error.code, message: error.message }, 409);
    }
    throw error;
  }
  const cliVersion = context.req.header('x-void-cli-version') ?? null;

  const actor = context.get('user');
  let owner = access.owner;

  const logger: DeployLogger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: actor.id,
    branch: null,
  });

  // Parse + validate the JSON body BEFORE the precheck-and-claim transaction.
  // A malformed body should not consume the project's active-deploy slot —
  // the JSON body can be validated up-front and rejected without ever
  // inserting a placeholder row.
  //
  // Stream the body through a counting TransformStream and let
  // `Response.json()` parse it incrementally. Buffering, decoding, and
  // JSON.parse-ing a body that can reach 64 MiB would hold several copies of
  // it at once; native parsing retains only the parsed object.
  if (!context.req.raw.body) {
    return context.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = context.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_JSON_DEPLOY_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsedBody: unknown;
  try {
    parsedBody = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return context.json(
        {
          error: `request body exceeds ${MAX_JSON_DEPLOY_BODY_BYTES} bytes: the Worker modules, including source maps, are too large to send inside the deploy request. Upgrade the void CLI; current versions upload Worker modules to storage directly.`,
        },
        413,
      );
    }
    return context.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsedBody == null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return context.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsedBody as Record<string, unknown>;

  // Manifest validation. `validateManifestShape` is the canonical source of
  // truth for what's accepted; the `assetManifestVersion === 2` check below
  // requires the v2 wire shape (blake3 + md5 + size per asset) that
  // direct-to-R2 deploys depend on.
  if (body.manifest == null || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
    return context.json(
      { event: 'error', message: 'manifest is required and must be an object' },
      400,
    );
  }
  const shapeError = validateManifestShape(body.manifest);
  if (shapeError) {
    return context.json({ event: 'error', message: shapeError }, 400);
  }
  const incomingManifest = body.manifest as DeployManifest;
  if (
    context.get('oauthApproval') &&
    !context.env.DEPLOYMENTS_QUEUE &&
    !context.get('deploymentExecution')
  ) {
    return context.json(
      {
        event: 'error',
        message: 'Connected app publishing requires the platform deployment Queue.',
      },
      503,
    );
  }
  if (context.get('oauthApproval') && !context.get('deploymentExecution')) {
    // The approved artifact digest commits to inline `workerFiles` bytes, so
    // an uploaded `workerInput` could not be checked against it.
    if (body.workerInput !== undefined) {
      return context.json(
        {
          event: 'error',
          message: 'Connected app publishes must send Worker modules in workerFiles.',
        },
        403,
      );
    }
    try {
      await verifyOAuthDeployment(
        context.get('db'),
        context.get('oauthApproval')!,
        projectId,
        context.req.header('x-void-deploy-idempotency-key'),
        body,
        context.get('companyIdentity'),
      );
    } catch (error) {
      return context.json(
        {
          event: 'error',
          message: error instanceof Error ? error.message : 'Publish approval is invalid.',
        },
        error instanceof OAuthError ? error.status : 403,
      );
    }
  }
  // Stored deployment manifests remain readable without this contract. Only
  // new SQLite builds that run migrations must include their verified plan.
  const migrations = incomingManifest.migrations;
  if (
    migrations &&
    migrations.pending > 0 &&
    (migrations.dialect === 'sqlite' || migrations.dialect === undefined) &&
    (migrations.protocolVersion !== 2 ||
      migrations.classifierVersion !== MIGRATION_CLASSIFIER_VERSION ||
      !/^sha256:[a-f0-9]{64}$/.test(migrations.migrationListHash ?? '') ||
      (migrations.stability !== 'stable' && migrations.stability !== 'legacy'))
  ) {
    return context.json(
      {
        event: 'error',
        message:
          'SQLite migrations require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.',
      },
      400,
    );
  }
  if (
    incomingManifest.emailProtocolVersion === 1 &&
    getPlatformCapabilities(context.env).email &&
    context.env.EMAIL_SENDER_DOMAIN
  ) {
    await reconcileSharedEmailRecipient(
      context.get('db'),
      context.env,
      projectId,
      incomingManifest,
    );
    // Only the slug gates a deploy: an alias rule that fails must not block
    // a deploy that would pass without the alias, which cannot be removed.
    const readiness = await getSharedEmailRecipientReadiness(
      context.get('db'),
      context.env,
      projectId,
      false,
      project.slug,
    );
    if (readiness?.status !== 'ready') {
      return context.json(
        {
          event: 'error',
          message:
            readiness?.reason ??
            'Shared email recipient routing is not ready; ask a platform administrator to reconcile shared email',
        },
        409,
      );
    }
  }
  if (incomingManifest.durableObjects?.runtime !== undefined) {
    return context.json(
      { event: 'error', message: 'durableObjects.runtime is reserved for the platform.' },
      400,
    );
  }

  if (incomingManifest.sandbox && incomingManifest.sandbox.controllerProtocol !== 2) {
    return context.json(
      {
        event: 'error',
        message:
          'Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.',
      },
      400,
    );
  }
  if (
    incomingManifest.sandbox &&
    ((incomingManifest.sandbox.image !== 'cloudflare/debian-trixie' &&
      !isSandboxRegistryImage(incomingManifest.sandbox.image)) ||
      (incomingManifest.sandbox.instanceType !== undefined &&
        !['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4'].includes(
          incomingManifest.sandbox.instanceType,
        )))
  ) {
    return context.json(
      {
        event: 'error',
        message:
          'Sandbox requires a digest-pinned Cloudflare registry image and a supported instance type.',
      },
      400,
    );
  }
  if (incomingManifest.sandbox && 'runtime' in incomingManifest.sandbox) {
    return context.json(
      { event: 'error', message: 'sandbox.runtime is reserved for the platform.' },
      400,
    );
  }
  if (incomingManifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
    return context.json(
      {
        event: 'error',
        message: 'This Void platform does not enable sandbox deployments.',
      },
      501,
    );
  }
  // Reject before any paid or slow work (Sandbox controllers, uploads,
  // migrations) when routing could not carry this project's protection yet.
  // The cutover fence repeats this check with the authoritative lock.
  try {
    await resolveProjectZeroTrustRouting(context.get('db'), projectId);
  } catch (error) {
    const message = zeroTrustNotReadyMessage(error);
    if (!message) {
      throw error;
    }
    return context.json({ event: 'error', error: 'zero trust not ready', message }, 409);
  }
  if (incomingManifest.sandbox) {
    try {
      await assertManagedSandboxEntitlement(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
    } catch (error) {
      return context.json(
        {
          event: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Cloudflare Containers access could not be verified.',
        },
        403,
      );
    }
  }
  if (
    incomingManifest.version == null ||
    !SUPPORTED_MANIFEST_VERSIONS.includes(incomingManifest.version)
  ) {
    return context.json(
      { event: 'error', message: 'Unsupported deploy manifest version. Please update void.' },
      400,
    );
  }
  if (incomingManifest.assetManifestVersion !== 2) {
    return context.json(
      {
        event: 'error',
        message: 'deploy requires assetManifestVersion: 2; please upgrade your void CLI',
      },
      400,
    );
  }

  // Validate the v2 asset manifest. Each entry MUST carry a 32-hex blake3
  // (storage key), 32-hex md5 (R2 PUT integrity check), and a non-negative
  // integer size. We translate the v2 entries into the v1 shape
  // (`{ hash: blake3, size }`) the rest of the pipeline expects — this
  // keeps the existing dedupe / retention / serving-manifest code paths
  // unchanged. The md5 isn't carried into the persisted manifest because
  // BLAKE3 is the storage-key identifier and md5 is purely a write-time
  // R2 integrity primitive.
  if (
    body.assetManifest == null ||
    typeof body.assetManifest !== 'object' ||
    Array.isArray(body.assetManifest)
  ) {
    return context.json(
      { event: 'error', message: 'assetManifest is required and must be an object' },
      400,
    );
  }
  const rawAssetManifest = body.assetManifest as Record<string, unknown>;
  const assetEntries = Object.entries(rawAssetManifest);
  if (assetEntries.length > MAX_UPLOAD_URLS_BATCH) {
    return context.json(
      {
        event: 'error',
        message: `assetManifest has ${assetEntries.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-deploy limit`,
      },
      400,
    );
  }
  const incomingAssetManifest: Record<string, AssetManifestEntry> = {};
  for (const [path, raw] of assetEntries) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return context.json(
        { event: 'error', message: `invalid assetManifest entry for ${path}: must be an object` },
        400,
      );
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.blake3 !== 'string' || !HEX_32_REGEX.test(entry.blake3)) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: blake3 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (typeof entry.md5 !== 'string' || !HEX_32_REGEX.test(entry.md5)) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: md5 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: size must be a non-negative integer`,
        },
        400,
      );
    }
    incomingAssetManifest[path] = { hash: entry.blake3, size: entry.size };
  }

  // Optional metadata fields.
  const source = typeof body.source === 'string' ? body.source : null;
  const commit = typeof body.commit === 'string' ? body.commit : null;
  const repositoryUrl = typeof body.repositoryUrl === 'string' ? body.repositoryUrl : null;
  const commitUrl = typeof body.commitUrl === 'string' ? body.commitUrl : null;
  const gitRef = typeof body.gitRef === 'string' ? body.gitRef : null;

  // Worker modules arrive one of two ways. Current CLIs upload them to R2
  // first and send `workerInput` (names, sizes, and digests). Older CLIs and
  // connected apps send base64 `workerFiles` keyed by relative path, each
  // capped at MAX_WORKER_FILE_BYTES (32 MiB). Neither means a static-only
  // deploy. The Queue executor passes the modules of the admitted input.
  const execution = context.get('deploymentExecution');
  const workerFiles: Array<WorkerModule> = execution?.workerFiles ?? [];
  // Decoded inline modules, which durable admission stages in R2.
  const inlineFiles: Array<{ name: string; content: Blob }> = [];
  let workerInput: WorkerInput | null = null;
  if (!execution && body.workerFiles !== undefined && body.workerInput !== undefined) {
    return context.json(
      { event: 'error', message: 'Send Worker modules in workerInput or workerFiles, not both.' },
      400,
    );
  }
  if (!execution && body.workerInput !== undefined) {
    const problem = workerInputProblem(body.workerInput);
    if (problem) {
      return context.json(
        {
          event: 'error',
          ...(problem.error ? { error: problem.error } : {}),
          message: problem.message,
        },
        problem.status,
      );
    }
    workerInput = body.workerInput as WorkerInput;
  }
  // Keys derive from the authenticated project and the validated upload id,
  // so a request can only name objects under its own project's prefix.
  const uploadPrefix = workerInput ? deploymentInputPrefix(projectId, workerInput.id) : null;
  const uploadedModules: DeploymentInput['modules'] = (workerInput?.modules ?? []).map(
    (module, index) => ({
      name: module.name,
      key: `${uploadPrefix}${index}`,
      digest: module.sha256,
      type: moduleContentType(module.name),
      size: module.size,
    }),
  );
  for (const module of uploadedModules) {
    workerFiles.push(deploymentInputModule(context.env.STATIC_ASSETS_R2, module, module.size!));
  }
  if (!execution && body.workerFiles !== undefined) {
    if (
      body.workerFiles == null ||
      typeof body.workerFiles !== 'object' ||
      Array.isArray(body.workerFiles)
    ) {
      return context.json(
        { event: 'error', message: 'workerFiles must be an object mapping relative path → base64' },
        400,
      );
    }
    // Decode each base64 module and `delete` its source string from the
    // parsed body before the next entry so V8 can reclaim it. A near-cap
    // module's base64 string is ~86 MiB as UTF-16; holding every source string
    // for the whole loop can push the isolate past 128 MiB on a single 32 MiB
    // module. `decodeBase64ToBytes` avoids a second intermediate string where
    // the runtime supports it.
    const workerFilesMap = body.workerFiles as Record<string, unknown>;
    for (const filePath of Object.keys(workerFilesMap)) {
      const raw = workerFilesMap[filePath];
      if (typeof raw !== 'string') {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} must be a base64-encoded string`,
          },
          400,
        );
      }
      let decoded: Uint8Array;
      try {
        decoded = decodeBase64ToBytes(raw);
      } catch (err) {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }
      // Release the source string back to GC now that the bytes are
      // materialized — see the block comment above.
      delete workerFilesMap[filePath];
      if (decoded.byteLength > MAX_WORKER_FILE_BYTES) {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} exceeds ${MAX_WORKER_FILE_BYTES} bytes`,
          },
          413,
        );
      }
      // Hand the bytes directly to a `Blob` so we never name the
      // `Uint8Array` past this scope — keeps per-iteration memory residency
      // bounded by one decoded module at a time.
      const content = new Blob([decoded as unknown as BlobPart], {
        type: moduleContentType(filePath),
      });
      inlineFiles.push({ name: filePath, content });
      workerFiles.push(blobWorkerModule(filePath, content));
    }
  }
  const hasWorkerFiles = workerFiles.length > 0;

  // Reject worker files for static manifest types. Without this check a
  // malformed CLI could send `workerFiles` for a `'spa'` / `'static'`
  // manifest and end up deploying a WfP worker, breaking the project type
  // invariants. Done BEFORE placeholder insert so a rejected request
  // doesn't leave a phantom row to reap.
  if (hasWorkerFiles && (incomingManifest.type === 'spa' || incomingManifest.type === 'static')) {
    return context.json(
      {
        event: 'error',
        message: 'worker parts are not allowed when manifest.type is spa or static',
      },
      400,
    );
  }

  // Module names become multipart part names in the Cloudflare upload. This
  // also covers modules restored from a staged deployment input.
  if (incomingManifest.durableObjects?.bindings.length && workerFiles.length === 0) {
    return context.json(
      { event: 'error', message: 'Custom Durable Objects require a Worker deployment.' },
      400,
    );
  }
  const workerFilesProblem = workerFilesError(
    workerFiles.map(({ name }) => name),
    incomingManifest.workerMain,
  );
  if (workerFilesProblem) {
    return context.json({ event: 'error', message: workerFilesProblem }, 400);
  }
  const durable = !execution && context.env.DEPLOYMENTS_QUEUE !== undefined;
  const idempotencyKey = context.req.header('x-void-deploy-idempotency-key') ?? crypto.randomUUID();
  if (durable && !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
    return context.json({ error: 'invalid deployment idempotency key' }, 400);
  }
  const inputOptions = {
    appType: incomingManifest.type,
    credentialId: context.get('deployCredential'),
    oauthApproval: context.get('oauthApproval'),
  };
  const uploadedInput =
    durable && workerInput
      ? await uploadedDeploymentInput(uploadPrefix!, body, uploadedModules, inputOptions)
      : null;
  if (uploadedInput) {
    // A retry of an admitted deploy gets its receipt even after the
    // operation's input cleanup deleted the upload. The precheck below
    // rejects the same key with different input.
    const existing = await findDeploymentOperation(
      context.get('db'),
      projectId,
      actor.id,
      idempotencyKey,
    );
    if (
      existing &&
      existing.input_digest === uploadedInput.digest &&
      existing.build_id === (deployBuild ?? null)
    ) {
      return deploymentReceiptResponse(context.get('db'), existing.id);
    }
  }
  if (workerInput) {
    const uploadProblem = await uploadedWorkerInputProblem(
      context.env.STATIC_ASSETS_R2,
      uploadPrefix!,
      workerInput.modules,
    );
    if (uploadProblem) {
      return context.json({ event: 'error', message: uploadProblem }, 400);
    }
  }

  // Pre-validation done — now run the atomic precheck-and-claim
  // transaction. FOR UPDATE on the project row, 10-minute stale-deploy
  // reaper, placeholder insert. Once the placeholder row exists, every
  // later failure must route through the catch / finally below to avoid
  // leaving it stranded in `pending`.
  const stagedInput = !durable
    ? null
    : uploadedInput
      ? await recordUploadedDeploymentInput(
          context.env.STATIC_ASSETS_R2,
          uploadedInput,
          incomingManifest.type,
        )
      : await prepareDeploymentInput(
          context.env.STATIC_ASSETS_R2,
          projectId,
          body,
          inlineFiles,
          inputOptions,
        );
  const cutoverOwnerId = execution?.operation.owner_id ?? crypto.randomUUID();
  let precheckResult:
    | {
        deployment: Awaited<ReturnType<typeof createDeployment>>;
        currentLiveDeployment: Awaited<ReturnType<typeof getDeployment>>;
        project: Project;
        owner: typeof owner;
        reconciledMarkerKeys?: ReadonlyArray<string>;
      }
    | { receipt: string }
    | { canceling: string }
    | { recoveryFailed: string }
    | { cpuLimit: Readonly<{ requested: number; maximum: number }> };
  try {
    precheckResult = await context.get('db').transaction(async (tx) => {
      if (
        durable &&
        (await installationDeploymentAdmissionClosed(tx, context.env.PLATFORM_INSTALLATION_ID))
      ) {
        throw new Error('deployment admission closed for platform maintenance');
      }
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const lockedProject = await getProject(tx, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
      }
      const lockedAccess = await requireActiveDeployAccess(tx, projectId, actor.id);
      const requestedCpuMs = incomingManifest.limits?.cpuMs;
      const maxCpuMs = (await resolvePlanLimits(tx, lockedAccess.owner.plan)).maxCpuMsPerRequest;
      if (requestedCpuMs !== undefined && maxCpuMs > 0 && requestedCpuMs > maxCpuMs) {
        return { cpuLimit: { requested: requestedCpuMs, maximum: maxCpuMs } } as const;
      }
      await requireNormalizedProject(tx, lockedProject);
      if (execution) {
        await assertDeploymentExecutionAuthority(tx, execution.operation);
        const operation = await getDeploymentOperation(tx, execution.operation.id);
        const deployment = await getDeployment(tx, execution.operation.id);
        if (
          !operation ||
          operation.owner_id !== execution.operation.owner_id ||
          operation.status !== 'running' ||
          !deployment ||
          deployment.status !== 'pending'
        ) {
          throw new Error('deployment execution claim is no longer active');
        }
        return {
          deployment,
          currentLiveDeployment: operation.original_active_id
            ? await getDeployment(tx, operation.original_active_id)
            : null,
          project: lockedAccess.project,
          owner: lockedAccess.owner,
        } as const;
      }
      if (stagedInput) {
        const existing = await findDeploymentOperation(tx, projectId, actor.id, idempotencyKey);
        if (existing) {
          if (
            existing.input_digest !== stagedInput.digest ||
            existing.build_id !== (deployBuild ?? null)
          ) {
            throw new Error('deployment idempotency key was reused for different input');
          }
          return { receipt: existing.id } as const;
        }
        if (workerInput) {
          // One operation owns an uploaded prefix, and its input cleanup
          // deletes it. A retry of the same deploy matched the key above.
          const [claimed] = await tx
            .select({ id: deploymentOperations.id })
            .from(deploymentOperations)
            .where(
              and(
                eq(deploymentOperations.project_id, projectId),
                eq(deploymentOperations.input_prefix, stagedInput.prefix),
              ),
            )
            .limit(1);
          if (claimed) {
            throw new Error(WORKER_UPLOAD_CLAIMED_MESSAGE);
          }
        }
      }
      const [unfinishedOperation] = await tx
        .select({ id: deploymentOperations.id })
        .from(deploymentOperations)
        .where(
          and(
            eq(deploymentOperations.project_id, projectId),
            drizzleSql`${deploymentOperations.status} <> 'terminal'`,
          ),
        )
        .limit(1);
      if (unfinishedOperation) {
        throw new ConcurrentDeployError(unfinishedOperation.id);
      }
      const committedActiveDeploymentId = lockedProject.active_deployment_id;
      let activeDeploy = await getActiveDeployment(tx, projectId);
      if (activeDeploy) {
        const operation = await getDeploymentOperation(tx, activeDeploy.id);
        if (operation && operation.status !== 'terminal') {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
      }
      let recoveredCutover: Deployment | null = null;
      let recoveryFailedDeploymentId: string | null = null;
      const reconciledMarkerKeys: Array<string> = [];
      if (
        activeDeploy &&
        (activeDeploy.status === 'cutover' || activeDeploy.status === 'compensating')
      ) {
        const protectedDeployment = activeDeploy;
        const boundBuildIsActive = async (buildId: string): Promise<boolean> => {
          try {
            await assertBoundBuildStillActive(tx, buildId, projectId);
            return true;
          } catch (error) {
            if (error instanceof Error && error.message === SUPERSEDED_BUILD_ERROR_MESSAGE) {
              return false;
            }
            throw error;
          }
        };
        const promoteProtectedDeployment = async (): Promise<void> => {
          const cutoverManifest = JSON.parse(protectedDeployment.manifest!) as DeployManifest;
          await updateDeploymentStatus(tx, protectedDeployment.id, 'live', undefined, {
            force: true,
          });
          await updateProjectType(
            tx,
            projectId,
            resolvePersistedDeploymentType(cutoverManifest, protectedDeployment),
          );
          await requestRotationIfReplacingUntrustedCode(tx, projectId, protectedDeployment.id);
          await setActiveDeployment(tx, projectId, protectedDeployment.id);
          await markDeploymentRetained(tx, protectedDeployment.id, true);
          recoveredCutover = { ...protectedDeployment, status: 'live', retained: true };
        };
        const [intentRaw, readyRaw, compensated] = await Promise.all([
          context.env.ROUTING.get(cutoverIntentKey(protectedDeployment.id)),
          context.env.ROUTING.get(cutoverReadyKey(protectedDeployment.id)),
          context.env.ROUTING.get(cutoverCompensatedKey(protectedDeployment.id)),
        ]);
        const intent = parseCutoverMarker(intentRaw);
        const ready = parseCutoverMarker(readyRaw);
        const readyMatchesIntent =
          protectedDeployment.status === 'cutover' &&
          intent?.projectId === projectId &&
          ready?.projectId === projectId &&
          ready.ownerId === intent.ownerId;
        let protectedBuildInactive = false;
        let protectedAssetsMissing = false;

        if (compensated === projectId) {
          await updateDeploymentStatus(
            tx,
            protectedDeployment.id,
            'failed',
            'cutover compensation completed',
            { force: true },
          );
          reconciledMarkerKeys.push(
            cutoverIntentKey(protectedDeployment.id),
            cutoverReadyKey(protectedDeployment.id),
            cutoverCompensatedKey(protectedDeployment.id),
          );
          activeDeploy = null;
        }

        if (activeDeploy && readyMatchesIntent) {
          let buildIsActive = true;
          if (ready.buildId && !(await boundBuildIsActive(ready.buildId))) {
            buildIsActive = false;
            protectedBuildInactive = true;
          }
          if (buildIsActive) {
            try {
              await assertPersistedDeploymentServingAssetsExist(context.env, protectedDeployment);
            } catch (error) {
              if (error instanceof StaticAssetDisappearedError) {
                buildIsActive = false;
                protectedAssetsMissing = true;
              } else {
                throw error;
              }
            }
            if (buildIsActive) {
              await promoteProtectedDeployment();
              reconciledMarkerKeys.push(
                cutoverIntentKey(protectedDeployment.id),
                cutoverReadyKey(protectedDeployment.id),
              );
              activeDeploy = null;
            }
          }
        }

        if (activeDeploy) {
          if (
            !protectedBuildInactive &&
            intent?.buildId &&
            !(await boundBuildIsActive(intent.buildId))
          ) {
            protectedBuildInactive = true;
          }
          const protectedUpdatedAtMs = databaseTimestampMs(protectedDeployment.updated_at);
          if (
            protectedDeployment.status !== 'compensating' &&
            !protectedBuildInactive &&
            !protectedAssetsMissing &&
            (protectedUpdatedAtMs === null ||
              Date.now() - protectedUpdatedAtMs < CUTOVER_RECOVERY_STALE_MS)
          ) {
            throw new ConcurrentDeployError(protectedDeployment.id);
          }

          // Take ownership from a request that has exceeded the platform's
          // maximum build lifetime. The old owner validates this marker before
          // every later external/final/compensation step and must stand down.
          const recoveryMarker: CutoverMarker = {
            projectId,
            ownerId: cutoverOwnerId,
            buildId: intent?.buildId ?? null,
          };
          await context.env.ROUTING.put(
            cutoverIntentKey(protectedDeployment.id),
            JSON.stringify(recoveryMarker),
          );

          const committedActive = committedActiveDeploymentId
            ? await getDeployment(tx, committedActiveDeploymentId)
            : null;
          const compensateRecovery = async (
            reason: string,
            originalError?: unknown,
          ): Promise<boolean> => {
            try {
              if (committedActive) {
                await replayDeploymentCutover(
                  context.env,
                  tx,
                  lockedProject,
                  committedActive,
                  lockedProject.type,
                  { restoreCommitted: true },
                );
              } else {
                await clearProjectExternalState(context.env, tx, lockedProject);
              }
              // Write the durable marker before the PostgreSQL transition. If
              // COMMIT acknowledgement is lost, the next recovery knows the
              // authoritative deployment was already restored and must never
              // replay the abandoned target again.
              await context.env.ROUTING.put(
                cutoverCompensatedKey(protectedDeployment.id),
                projectId,
              );
            } catch (compensationError) {
              await updateDeploymentStatus(
                tx,
                protectedDeployment.id,
                'compensating',
                'cutover recovery compensation incomplete',
                { force: true },
              );
              recoveryFailedDeploymentId = protectedDeployment.id;
              logger.error('precheck', 'cutover_recovery_compensation_failed', compensationError, {
                deploymentId: protectedDeployment.id,
                ...(originalError !== undefined && {
                  originalError:
                    originalError instanceof Error ? originalError.message : String(originalError),
                }),
              });
              return false;
            }
            await updateDeploymentStatus(tx, protectedDeployment.id, 'failed', reason, {
              force: true,
            });
            return true;
          };
          let replayProtectedDeployment =
            protectedDeployment.status === 'cutover' &&
            !protectedBuildInactive &&
            !protectedAssetsMissing;
          if (
            replayProtectedDeployment &&
            recoveryMarker.buildId &&
            !(await boundBuildIsActive(recoveryMarker.buildId))
          ) {
            replayProtectedDeployment = false;
          }
          if (replayProtectedDeployment) {
            let replayError: unknown;
            try {
              await replayDeploymentCutover(context.env, tx, lockedProject, protectedDeployment);
              await assertPersistedDeploymentServingAssetsExist(context.env, protectedDeployment);
              await context.env.ROUTING.put(
                cutoverReadyKey(protectedDeployment.id),
                JSON.stringify(recoveryMarker),
              );
            } catch (error) {
              replayError = error;
            }
            if (replayError === undefined) {
              await promoteProtectedDeployment();
            } else {
              await compensateRecovery('cutover replay failed and was compensated', replayError);
            }
          } else {
            await compensateRecovery(
              compensated === projectId
                ? 'cutover compensation recovered'
                : 'abandoned cutover recovered',
            );
          }
          reconciledMarkerKeys.push(
            cutoverIntentKey(protectedDeployment.id),
            cutoverReadyKey(protectedDeployment.id),
            cutoverCompensatedKey(protectedDeployment.id),
          );
          activeDeploy = null;
        }
      }
      if (recoveryFailedDeploymentId) {
        return { recoveryFailed: recoveryFailedDeploymentId } as const;
      }
      if (activeDeploy) {
        if (activeDeploy.source === 'rollback-lease') {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const activeUpdatedAtMs = databaseTimestampMs(activeDeploy.updated_at);
        if (activeUpdatedAtMs === null) {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const ageMs = Date.now() - activeUpdatedAtMs;
        if (ageMs < 10 * 60 * 1000) {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const staleNext = activeDeploy.status === 'canceling' ? 'canceled' : 'canceling';
        logger.info('status_transition', 'status_change', {
          deploymentId: activeDeploy.id,
          from: activeDeploy.status,
          to: staleNext,
          reason: 'precheck_reap_timeout',
        });
        await updateDeploymentStatus(tx, activeDeploy.id, staleNext, 'timed out', {
          force: true,
        });
        if (staleNext === 'canceling') {
          return { canceling: activeDeploy.id } as const;
        }
      }
      const currentLiveDeployment =
        recoveredCutover ??
        (committedActiveDeploymentId ? await getDeployment(tx, committedActiveDeploymentId) : null);
      const deployment = await createDeployment(tx, projectId, null, null, null, {
        cliVersion,
        // Protect reused objects before the first inventory read. Unlike new
        // PUTs, old objects have no recent-upload grace period. GC acquires this
        // same project lock and includes nonterminal rows in its protected set.
        ...(hasWorkerFiles ? { assetHashes: JSON.stringify(incomingAssetManifest) } : {}),
        billingUserId: lockedAccess.owner.id,
        initiatedByUserId: actor.id,
      });
      if (stagedInput) {
        await tx.insert(deploymentOperations).values({
          id: deployment.id,
          project_id: projectId,
          actor_id: actor.id,
          build_id: deployBuild ?? null,
          original_active_id: currentLiveDeployment?.id ?? null,
          cli_version: cliVersion,
          idempotency_key: idempotencyKey,
          input_digest: stagedInput.digest,
          input_prefix: stagedInput.prefix,
          payload: stagedInput.input,
        });
      }
      return {
        deployment,
        currentLiveDeployment,
        project: lockedAccess.project,
        owner: lockedAccess.owner,
        ...(reconciledMarkerKeys.length > 0 && { reconciledMarkerKeys }),
      } as const;
    });
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(err), 403);
    }
    if (err instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: err.code, message: err.message }, 409);
    }
    if (err instanceof ConcurrentDeployError) {
      return context.json({ error: 'deploy in progress', deployment: err.deploymentId }, 409);
    }
    if (
      err instanceof Error &&
      (err.message === 'deployment admission closed for platform maintenance' ||
        err.message === 'deployment idempotency key was reused for different input' ||
        err.message === WORKER_UPLOAD_CLAIMED_MESSAGE)
    ) {
      return context.json({ error: err.message }, 409);
    }
    if (err instanceof Error && err.message === PROJECT_DELETING_ERROR_MESSAGE) {
      return context.json({ error: 'project is being deleted' }, 410);
    }
    throw err;
  }
  // Delete only input this request staged itself. A CLI upload's prefix can
  // belong to the operation a retried request matched; its operation or the
  // stale-input sweep removes it.
  if (stagedInput && !workerInput && !('deployment' in precheckResult)) {
    await paginatedR2Delete(context.env.STATIC_ASSETS_R2, stagedInput.prefix).catch(() => {});
  }
  if ('receipt' in precheckResult) {
    return deploymentReceiptResponse(context.get('db'), precheckResult.receipt);
  }
  if ('recoveryFailed' in precheckResult) {
    return context.json(
      {
        error: 'deployment recovery is incomplete; retry the deploy',
        deployment: precheckResult.recoveryFailed,
      },
      503,
    );
  }
  if ('cpuLimit' in precheckResult) {
    return context.json(
      {
        event: 'error',
        message: `limits.cpuMs ${precheckResult.cpuLimit.requested} exceeds your plan maximum of ${precheckResult.cpuLimit.maximum}`,
      },
      400,
    );
  }
  if ('canceling' in precheckResult) {
    return context.json(
      { error: 'deploy cancellation requested', deployment: precheckResult.canceling },
      409,
    );
  }
  for (const markerKey of precheckResult.reconciledMarkerKeys ?? []) {
    await context.env.ROUTING.delete(markerKey).catch(() => {
      // Once the PostgreSQL recovery transaction is acknowledged, stale
      // marker bytes are harmless and can be removed by a later attempt.
    });
  }
  const preDeployment = precheckResult.deployment;
  const currentLiveDeployment = precheckResult.currentLiveDeployment;
  project = precheckResult.project;
  owner = precheckResult.owner;
  const originalActiveDeploymentId = currentLiveDeployment?.id ?? null;

  if (durable) {
    await dispatchDeploymentOperation(context.env, context.get('db'), preDeployment.id).catch(
      (error) => {
        // The committed outbox will retry a missing/lost Queue acknowledgement.
        logger.warn('queue', 'dispatch_pending', { err: String(error) });
      },
    );
    return deploymentReceiptResponse(context.get('db'), preDeployment.id);
  }
  return await runDeploymentPipeline({
    context,
    owner,
    preDeployment,
    logger,
    execution,
    cutoverOwnerId,
    projectId,
    actor,
    originalActiveDeploymentId,
    project,
    incomingAssetManifest,
    currentLiveDeployment,
    incomingManifest,
    hasWorkerFiles,
    source,
    commit,
    cliVersion,
    repositoryUrl,
    commitUrl,
    gitRef,
    deployBuild,
    workerFiles,
    // Without the Queue the deploy runs in this request. Delete the CLI's
    // upload once it reaches a terminal state, as the Queue consumer does.
    releaseWorkerInput: uploadPrefix
      ? () => paginatedR2Delete(context.env.STATIC_ASSETS_R2, uploadPrefix).then(() => {})
      : undefined,
  });
}
