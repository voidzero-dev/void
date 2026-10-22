import { sql as drizzleSql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { findMissingR2Assets, persistedR2AssetSizes } from '../asset-inventory.ts';
import { activeOAuthApproval, OAuthError } from '../auth/oauth.ts';
import { uploadPool } from '../concurrency.ts';
import { getProject, getUser, getDeployment, updateDeploymentStatus, type Db } from '../db.ts';
import { handleManifestOnlyDeploy } from '../deploy/execute.ts';
import { requireActiveDeployAccess } from '../deploy/recovery.ts';
import {
  HEX_32_REGEX,
  MAX_UPLOAD_URLS_BATCH,
  moduleContentType,
  workerUploadModulesProblem,
  type UploadUrlsRequestAsset,
  type WorkerUploadModule,
} from '../deploy/shared.ts';
import {
  appendDeploymentEvent,
  assertDeploymentExecutionAuthority,
  deploymentEventPage,
  deploymentInputModule,
  deploymentInputPrefix,
  getDeploymentOperation,
  type DeploymentOperation,
} from '../deployment-execution.ts';
import type { ApiEnv } from '../env.ts';
import { checkCliVersionOrRespond } from '../middleware/cli-version.ts';
import { createDeployLogger, type DeployLogger } from '../observability/logger.ts';
import { ProjectAccessDeniedError, projectAccessErrorBody } from '../project-access.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import { presignAssetPut } from '../r2-presign.ts';
import { listR2Objects, type WorkerModule } from '../worker-upload.ts';
import { requireProjectRouteCapability } from './project-access.ts';

export {
  MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES,
  MAX_ROUTING_RULES,
  validateManifestShape,
} from '@void/deploy-core';

const app = new Hono<ApiEnv>();

// Body cap for `POST /:id/deploy/upload-urls` and `/worker-upload-urls`. The
// body is dominated by `assets[]` entries — each entry is ~150 bytes (blake3 +
// md5 + size + contentType) — or `modules[]` entries of similar size (name +
// size + sha256). 5000 entries × ~150 bytes ≈ 750 KB, so 4 MiB carries a
// 4× safety margin. Asset and module BYTES never travel these endpoints —
// they go direct-to-R2 via the presigned PUTs the endpoints issue.
const MAX_UPLOAD_URLS_BODY_BYTES = 4 * 1024 * 1024;

// 30 minutes. On a slow uplink a tail asset can wait in the upload pool for
// more than 10 minutes before its first PUT, and the CLI treats R2's 403
// SignatureExpired as terminal. Longer deploys need the re-presign-on-expiry
// follow-up noted on `/deploy/upload-urls`.
const UPLOAD_URL_TTL_SECONDS = 1800;

// Bounded concurrency for the presign batch. Presigning is CPU-light;
// 50 in-flight is generous and keeps tail latency bounded without
// fanning out to 5000 simultaneous async tasks.
const PRESIGN_BATCH_CONCURRENCY = 50;

/**
 * Validate a single `assets[]` entry from `POST /:id/deploy/upload-urls`.
 * Returns an error message on failure, `null` on success. Mirrors the
 * presigner's MD5 validation so a malformed input is rejected at the
 * platform boundary rather than inside `presignAssetPut`.
 */
function validateUploadUrlsAsset(asset: unknown, index: number): string | null {
  if (asset == null || typeof asset !== 'object' || Array.isArray(asset)) {
    return `invalid assets[${index}]: must be an object`;
  }
  const assetObject = asset as Record<string, unknown>;
  if (typeof assetObject.blake3 !== 'string' || !HEX_32_REGEX.test(assetObject.blake3)) {
    return `invalid assets[${index}].blake3: must be 32 lowercase hex characters`;
  }
  if (typeof assetObject.md5 !== 'string' || !HEX_32_REGEX.test(assetObject.md5)) {
    return `invalid assets[${index}].md5: must be 32 lowercase hex characters`;
  }
  if (
    typeof assetObject.size !== 'number' ||
    !Number.isInteger(assetObject.size) ||
    assetObject.size < 0
  ) {
    return `invalid assets[${index}].size: must be a non-negative integer`;
  }
  if (typeof assetObject.contentType !== 'string' || assetObject.contentType.length === 0) {
    return `invalid assets[${index}].contentType: must be a non-empty string`;
  }
  return null;
}

// Sentinel thrown out of the upload-urls FOR-SHARE transaction to signal
// "project flipped to status='deleting' before we acquired the lock".
// Caught at the awaiting site to surface a 410 to the CLI. Mirrors the
// `PROJECT_DELETING_ERROR_MESSAGE` pattern used by `handleManifestOnlyDeploy`.
const UPLOAD_URLS_PROJECT_DELETING = 'upload_urls:project_deleting';

/**
 * Issue presigned R2 PUT URLs for a batch of declared assets.
 *
 * Project access is handled the same way as `/deploy/preflight`: the actor
 * needs deploy capability and the current owner must be active.
 * Each asset's blake3 keys it under `assets/${projectId}/${blake3}`; MD5
 * is signed into the URL's headers so R2 enforces "uploaded bytes' MD5
 * matches declared MD5" at write time. URLs expire in 30 minutes.
 *
 * Returns `{ urls: { [blake3]: { url, headers } } }`. Note: when two
 * assets in the batch share a blake3 (deduplicated content under
 * different paths), the second write to the result map wins — both are
 * pointed at the same key, so this is the intended dedupe behaviour.
 *
 * FOLLOW-UP: For very slow deploys (large bundles + low bandwidth + low
 * upload concurrency), a 30-min TTL can still expire on the tail of the
 * upload pool before that asset's PUT runs. The next iteration of this
 * endpoint should re-presign on `SignatureExpired` 403 from R2 — keyed
 * off a CLI-side retry against `/deploy/upload-urls` for the affected
 * blake3s. Tracking issue: see meta/design-docs/0068 follow-up.
 */
app.post('/:id/deploy/upload-urls', async (context) => {
  const request = await beginUploadUrlsRequest(context);
  if (request instanceof Response) {
    return request;
  }
  const { projectId, logger, startedAt, body } = request;
  // TODO(orphan-gc): authenticated users can upload bytes via upload-urls
  // without ever finalizing a deploy, leaving durable orphans. Teardown
  // cleans these up; for active projects, abandoned uploads accumulate
  // until a future deploy's retention cleanup happens to walk over them.
  // Track in a follow-up: add a periodic per-project R2 sweep that diffs
  // `assets/${projectId}/*` against the union of retained manifests.
  if (!Array.isArray(body.assets)) {
    return context.json({ error: 'request body must include an `assets` array' }, 400);
  }
  if (body.assets.length > MAX_UPLOAD_URLS_BATCH) {
    return context.json(
      {
        error: `assets[] has ${body.assets.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-request limit`,
      },
      400,
    );
  }
  for (let i = 0; i < body.assets.length; i++) {
    const err = validateUploadUrlsAsset(body.assets[i], i);
    if (err) {
      return context.json({ error: err }, 400);
    }
  }
  const assets = body.assets as ReadonlyArray<UploadUrlsRequestAsset>;

  logger.info('upload_urls', 'request', { assetCount: assets.length });

  const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
  const failed = await presignUnderProjectLock(
    context,
    projectId,
    logger,
    { step: 'upload_urls', assetCount: assets.length },
    async (tx, signingKeyCache) => {
      if (context.get('oauthApproval')) {
        const { approval } = await activeOAuthApproval(
          tx,
          context.get('oauthApproval')!,
          context.get('companyIdentity'),
          true,
        );
        const approved = new Set(
          Object.values(approval.data.artifact!.assetManifest).map(
            (entry) => `${entry.blake3}:${entry.md5}:${entry.size}`,
          ),
        );
        if (
          approval.data.projectId !== projectId ||
          assets.some((asset) => !approved.has(`${asset.blake3}:${asset.md5}:${asset.size}`))
        ) {
          throw new OAuthError(
            'access_denied',
            'Upload only the assets approved for this publish.',
            403,
          );
        }
      }
      await uploadPool(assets, PRESIGN_BATCH_CONCURRENCY, async (asset) => {
        const result = await presignAssetPut(
          {
            accountId: context.env.CF_ACCOUNT_ID,
            accessKeyId: context.env.R2_ACCESS_KEY_ID,
            secretAccessKey: context.env.R2_SECRET_ACCESS_KEY,
            bucket: context.env.R2_STATIC_ASSETS_BUCKET,
            key: `assets/${projectId}/${asset.blake3}`,
            md5: asset.md5,
            contentType: asset.contentType,
            ttlSeconds: context.get('oauthApproval')
              ? Math.max(
                  1,
                  Math.min(
                    900,
                    context.get('deployTokenExpiresAt')! - Math.floor(Date.now() / 1000),
                  ),
                )
              : UPLOAD_URL_TTL_SECONDS,
            ...(context.get('oauthApproval')
              ? { ifNoneMatch: '*' as const, contentLength: asset.size }
              : {}),
          },
          signingKeyCache,
        );
        // Last-write-wins on duplicate blake3 — see docstring above. Map
        // assignment is synchronous so concurrent pool tasks do not race
        // beyond a benign last-writer.
        urls[asset.blake3] = result;
      });
    },
  );
  if (failed) {
    return failed;
  }

  logger.info('upload_urls', 'response', {
    urlsIssued: Object.keys(urls).length,
    durationMs: Date.now() - startedAt,
  });

  return context.json({ urls });
});

/**
 * Issue presigned R2 PUT URLs for a deploy's Worker modules.
 *
 * Worker modules, source maps included, can exceed what a deploy request
 * body carries, so the CLI uploads them first and finalizes with
 * `workerInput: { id, modules }`. Module `i` is stored at
 * `deployment-inputs/${projectId}/${id}/${i}` — the durable deployment input
 * prefix family, so operation input cleanup, the stale-input sweep, and
 * project teardown all cover it. Each URL signs Content-Type and
 * Content-Length, so R2 stores exactly the declared size; the SHA-256 is
 * checked when the bytes stream to Cloudflare. URLs expire in 30 minutes.
 *
 * Connected-app credentials cannot reach this route (see `authMiddleware`):
 * they send modules inline, where their approval digest covers them.
 *
 * Returns `{ id, urls: [{ url, headers }] }`, with `urls` in `modules` order.
 */
app.post('/:id/deploy/worker-upload-urls', async (context) => {
  const request = await beginUploadUrlsRequest(context);
  if (request instanceof Response) {
    return request;
  }
  const { projectId, logger, startedAt, body } = request;
  const problem = workerUploadModulesProblem(body.modules, 'modules');
  if (problem) {
    return context.json(
      problem.error
        ? { error: problem.error, message: problem.message }
        : { error: problem.message },
      problem.status,
    );
  }
  const modules = body.modules as ReadonlyArray<WorkerUploadModule>;
  const id = crypto.randomUUID();
  const prefix = deploymentInputPrefix(projectId, id);

  logger.info('worker_upload_urls', 'request', { moduleCount: modules.length });

  const urls: Array<{ url: string; headers: Record<string, string> }> = [];
  const failed = await presignUnderProjectLock(
    context,
    projectId,
    logger,
    { step: 'worker_upload_urls', moduleCount: modules.length },
    async (_tx, signingKeyCache) => {
      await uploadPool([...modules.keys()], PRESIGN_BATCH_CONCURRENCY, async (index) => {
        const module = modules[index]!;
        urls[index] = await presignAssetPut(
          {
            accountId: context.env.CF_ACCOUNT_ID,
            accessKeyId: context.env.R2_ACCESS_KEY_ID,
            secretAccessKey: context.env.R2_SECRET_ACCESS_KEY,
            bucket: context.env.R2_STATIC_ASSETS_BUCKET,
            key: `${prefix}${index}`,
            contentType: moduleContentType(module.name),
            contentLength: module.size,
            ttlSeconds: UPLOAD_URL_TTL_SECONDS,
          },
          signingKeyCache,
        );
      });
    },
  );
  if (failed) {
    return failed;
  }

  logger.info('worker_upload_urls', 'response', {
    urlsIssued: urls.length,
    durationMs: Date.now() - startedAt,
  });

  return context.json({ id, urls });
});

/**
 * The shared start of the direct-upload URL routes: deploy capability, the
 * deleting/version/normalization gates, and a size-capped JSON object body.
 * Returns the error response when a gate rejects the request.
 */
async function beginUploadUrlsRequest(context: Context<ApiEnv>): Promise<
  | Response
  | Readonly<{
      projectId: string;
      logger: DeployLogger;
      startedAt: number;
      body: Record<string, unknown>;
    }>
> {
  const projectId = context.req.param('id') as string;
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  const project = access.project;
  // Fast 410 — mirror `handleManifestOnlyDeploy`. The unlocked read here
  // is a TOCTOU best-effort: it short-circuits the common case (project
  // already marked `deleting` before this request arrived). The
  // authoritative status check happens inside the FOR-SHARE transaction
  // below so a teardown that lands AFTER this read but BEFORE we issue
  // presigns is forced to wait until our share lock releases — and any
  // teardown that already committed before we acquired the lock will be
  // observed by the in-tx re-read and surface as a 410.
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs BEFORE body parsing so a stale CLI sending a
  // multipart body gets the friendly 426 upgrade message instead of an
  // opaque "invalid JSON body" 400 from the JSON parse below. Runs AFTER
  // the unlocked 410 fast-path so a stale CLI hitting an already-deleting
  // project still sees the more specific 410 ("upgrading won't bring the
  // project back"). The remaining 426-vs-410 race window — where the
  // status flips to `deleting` between the unlocked check and this gate
  // — is microseconds (no I/O between them) and surfaces as 426 to the
  // CLI; that's a UX wart, not a correctness bug, since the user does
  // need to upgrade anyway.
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

  const startedAt = Date.now();
  const logger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: context.get('user').id,
    branch: null,
  });

  // Stream the body with a hard size cap before JSON.parse — `context.req.json()`
  // would otherwise buffer arbitrary bytes from a malicious / buggy client
  // before parsing, peaking at body bytes plus a UTF-16 string plus the
  // parsed object. The cap is enforced via TransformStream so we abort the
  // moment the threshold is crossed; native `Response.json()` then handles
  // streaming + parsing efficiently. Mirrors `handleManifestOnlyDeploy`.
  if (!context.req.raw.body) {
    return context.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = context.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_UPLOAD_URLS_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsed: unknown;
  try {
    parsed = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return context.json(
        {
          error: `request body exceeds ${MAX_UPLOAD_URLS_BODY_BYTES} bytes`,
        },
        413,
      );
    }
    return context.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return context.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  return { projectId, logger, startedAt, body };
}

/**
 * Run `presign` under the project's share lock and map the failures both
 * direct-upload URL routes report. Returns an error response, or null once
 * every URL is issued.
 */
async function presignUnderProjectLock(
  context: Context<ApiEnv>,
  projectId: string,
  logger: DeployLogger,
  log: Readonly<{ step: string } & Record<string, unknown>>,
  presign: (tx: Db, signingKeyCache: Map<string, ArrayBuffer>) => Promise<void>,
): Promise<Response | null> {
  const { step, ...logFields } = log;
  try {
    // Serialize against project teardown. `lockAndMarkDeleting` takes
    // FOR UPDATE on the project row in `provisioning/cleanup.ts`; we take
    // FOR SHARE here, which is compatible with concurrent upload-urls /
    // deploy precheck calls (also FOR SHARE / FOR UPDATE on the same row,
    // queueing as Postgres allows) but blocks teardown until this
    // transaction commits. Once the lock is acquired we re-read the
    // project row inside the transaction; if status flipped to `deleting`
    // between the unlocked early-out and the lock acquisition, throw the
    // sentinel to surface a 410 to the CLI.
    //
    // Lock window: presigning is pure HMAC (no R2 / DB / network I/O
    // beyond the initial SELECT FOR SHARE). A 5000-entry batch fans out
    // to 50 concurrent crypto.subtle signs and finishes in ~250 ms, so
    // teardown never waits long for the share lock to release.
    await context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR SHARE`);
      const lockedProject = await getProject(tx, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(UPLOAD_URLS_PROJECT_DELETING);
      }
      // Derived signing keys are identical within this request. Keep the cache
      // request-local so credentials and derived keys are released with the batch.
      const signingKeyCache = new Map<string, ArrayBuffer>();
      await requireActiveDeployAccess(tx, projectId, context.get('user').id);
      await requireNormalizedProject(tx, lockedProject);
      await presign(tx, signingKeyCache);
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      return context.json({ error: err.code, message: err.message }, err.status);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(err), 403);
    }
    if (err instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: err.code, message: err.message }, 409);
    }
    if (err instanceof Error && err.message === UPLOAD_URLS_PROJECT_DELETING) {
      return context.json({ error: 'project is being deleted' }, 410);
    }
    logger.error(step, 'presign_error', err, logFields);
    return context.json(
      {
        error: `failed to presign upload URLs: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }
  return null;
}

// Deploy to a project
app.post('/:id/deploy', handleManifestOnlyDeploy);

export async function executeQueuedDeployment(
  env: ApiEnv['Bindings'],
  db: Db,
  operation: DeploymentOperation,
): Promise<void> {
  const actor = await getUser(db, operation.actor_id);
  if (!actor) {
    await updateDeploymentStatus(
      db,
      operation.id,
      'failed',
      'Deployment actor is no longer active',
      { force: true },
    );
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Deployment actor is no longer active',
      step: 'authorization',
    });
    return;
  }
  const initial = await getDeployment(db, operation.id);
  if (initial?.status === 'canceling' || initial?.status === 'canceled') {
    await updateDeploymentStatus(db, operation.id, 'canceled', undefined, { force: true });
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: initial.error_message ?? 'Deployment was canceled',
      step: 'canceled',
    });
    return;
  }
  try {
    await assertDeploymentExecutionAuthority(db, operation);
  } catch {
    await updateDeploymentStatus(
      db,
      operation.id,
      'failed',
      'Deployment actor or credential is no longer active',
      { force: true },
    );
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Deployment actor or credential is no longer active',
      step: 'authorization',
    });
    return;
  }
  // One listing confirms every staged module and its size before execution
  // touches provider state, and supplies sizes for inputs staged before they
  // were recorded. Bytes stream from R2 during the Cloudflare upload and are
  // checked against their digests there.
  const workerFiles: Array<WorkerModule> = [];
  const staged = operation.payload.modules.length
    ? await listR2Objects(env.STATIC_ASSETS_R2, operation.input_prefix)
    : new Map<string, { size: number }>();
  for (const module of operation.payload.modules) {
    const object = staged.get(module.key);
    if (!object) {
      throw new Error('Durable deployment input is missing');
    }
    if (module.size !== undefined && module.size !== object.size) {
      throw new Error('Durable deployment input digest mismatch');
    }
    workerFiles.push(deploymentInputModule(env.STATIC_ASSETS_R2, module, object.size));
  }
  const executor = new Hono<ApiEnv>()
    .onError((error) => {
      throw error;
    })
    .use('*', async (context, next) => {
      context.set('db', db);
      context.set('user', actor);
      context.set('deployScope', operation.project_id);
      if (operation.payload.credentialId) {
        context.set('deployCredential', operation.payload.credentialId);
      }
      if (operation.payload.oauthApproval) {
        context.set('oauthApproval', operation.payload.oauthApproval);
      }
      if (operation.build_id) {
        context.set('deployBuild', operation.build_id);
      }
      context.set('deploymentExecution', { operation, workerFiles });
      await next();
    })
    .post('/:id/deploy', handleManifestOnlyDeploy);
  const response = await executor.fetch(
    new Request(`https://deployment.invalid/${operation.project_id}/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(operation.cli_version ? { 'x-void-cli-version': operation.cli_version } : {}),
      },
      body: JSON.stringify(operation.payload.body),
    }),
    env,
  );
  if (response.status !== 204) {
    // A rejected admitted input never entered the pipeline. No provider write
    // occurred, so its placeholder can be finalized without replaying it.
    await db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT id FROM projects WHERE id = ${operation.project_id} FOR UPDATE`,
      );
      const candidate = await getDeployment(tx, operation.id);
      if (!candidate || candidate.manifest !== null || candidate.status !== 'pending') {
        throw new Error('Admitted deployment needs reconciliation');
      }
      await updateDeploymentStatus(
        tx,
        operation.id,
        'failed',
        'Admitted deployment is no longer authorized or valid',
        { force: true },
      );
    });
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Admitted deployment is no longer authorized or valid',
      step: 'authorization',
    });
  }
}

app.get('/:id/deployments/:deploymentId/events', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'read');
  if (access instanceof Response) {
    return access;
  }
  if (context.get('deployScope') && context.get('deployScope') !== projectId) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const since = Number(context.req.query('since') ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) {
    return context.json({ error: 'invalid progress cursor' }, 400);
  }
  const operation = await getDeploymentOperation(
    context.get('db'),
    context.req.param('deploymentId'),
  );
  if (!operation || operation.project_id !== projectId) {
    return context.json({ error: 'deployment receipt not found' }, 404);
  }
  return context.json(deploymentEventPage(operation, since));
});

// Deploy preflight — returns which assets need uploading based on diff with last deploy
app.post('/:id/deploy/preflight', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  const project = access.project;
  // Mirror /upload-urls and handleManifestOnlyDeploy: short-circuit when
  // the project is being torn down so callers get the more specific 410
  // before any body parsing or version-gate work. A stale CLI on a
  // deleting project should see "project is being deleted", not "upgrade
  // your CLI" — upgrading won't make the project come back.
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz + status so a stale CLI
  // hitting a missing/foreign/deleting project gets the more specific
  // 404/403/410 first instead of a misleading "upgrade your CLI" 426.
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

  const body = await context.req.json<{
    assetManifest: Record<string, { hash: string; size: number }>;
    hasWorker?: boolean;
  }>();
  const { assetManifest } = body;
  const total = Object.keys(assetManifest).length;
  // Both static and Worker deployments require the platform-owned scoped R2
  // copy. Provider asset deduplication and historical KV placement are not
  // evidence that the current serving store has these bytes.
  const valid =
    total <= MAX_UPLOAD_URLS_BATCH &&
    Object.values(assetManifest).every(
      (entry) =>
        entry &&
        typeof entry.hash === 'string' &&
        HEX_32_REGEX.test(entry.hash) &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0,
    );
  if (!valid) {
    return context.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
  }
  const active = project.active_deployment_id
    ? await getDeployment(context.get('db'), project.active_deployment_id)
    : null;
  const activeR2Sizes =
    active?.status === 'live' && active.project_id === projectId
      ? persistedR2AssetSizes(active.asset_hashes)
      : new Map<string, number>();
  const unverified = Object.fromEntries(
    Object.entries(assetManifest).filter(
      ([, entry]) => activeR2Sizes.get(entry.hash) !== entry.size,
    ),
  );
  const needed = await findMissingR2Assets(context.env.STATIC_ASSETS_R2, projectId, unverified);
  return context.json({ needed, total, skipped: total - needed.length });
});

export default app;

export { databaseTimestampMs, settleDeploymentForSandboxDrain } from '../deploy/recovery.ts';

export {
  buildDurableObjectUploadMigrations,
  buildWebSocketUploadBindings,
  buildSandboxUploadBindings,
  buildLiveUploadBindings,
  enrichWebSocketManifest,
  enrichLiveManifest,
} from '../deploy/durable-bindings.ts';

export { clearIsrCache } from '../deploy/cache.ts';
