import { and, eq, sql } from 'drizzle-orm';
import {
  createAssetUploadSession,
  normalizeForCfAssetSession,
  uploadAssetBuckets,
  buildAssetMetadata,
  resolveAssetContentTypes,
  type AssetManifestEntry,
} from '../assets.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { getProjectResources, type Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { encryptPlatformCredential, decryptPlatformCredential } from '../project-secrets.ts';
import { projects, resources, deployments } from '../schema.ts';
import type { DeployManifest, Resource } from '../types.ts';
import {
  WORKER_UPLOAD_BUDGET_MS,
  WORKER_UPLOAD_IDLE_MS,
  WORKER_UPLOAD_RESPONSE_MS,
  blobWorkerModule,
  listR2Objects,
  r2WorkerModule,
  streamSha256,
  uploadWatchdog,
  withKnownLength,
  workerUploadBody,
  type WorkerModule,
} from '../worker-upload.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import { putDurableSnapshotModule, putDurableSnapshotObject } from './durable-snapshot.ts';

type Env = ApiEnv['Bindings'];
type Binding = Record<string, unknown> & { type: string; name: string };
type Snapshot = {
  metadata: Record<string, unknown> & { bindings: Array<Binding> };
  files: Array<{ name: string; contentType: string; sha256: string }>;
};
type Credential = Awaited<ReturnType<typeof encryptPlatformCredential>>;
const OWNER = '__VOID_DURABLE_OWNER';
const RELEASE = '__VOID_DURABLE_DEPLOYMENT';
const ENTRY = '__void_durable_entry.js';

function namespace(env: Pick<Env, 'DISPATCH_NAMESPACE'>): string {
  return env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
}

async function hash(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function durableObjectWorkerName(
  projectId: string,
  className: string,
): Promise<string> {
  const digest = await hash(new TextEncoder().encode(className).buffer);
  return `void-do-${projectId}-${digest.slice(0, 16)}`;
}

function url(env: Env, worker: string): string {
  return `${CF_API_BASE}/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace(env)}/scripts/${worker}`;
}

function marker(
  env: Pick<Env, 'DISPATCH_NAMESPACE'>,
  projectId: string,
  className: string,
): string {
  return JSON.stringify({ protocol: 1, projectId, dispatchNamespace: namespace(env), className });
}

async function readBindings(env: Env, worker: string): Promise<Array<Binding> | undefined> {
  try {
    const bindings = await cfFetch<Array<Binding>>(
      `${url(env, worker)}/bindings`,
      env.CF_API_TOKEN,
    );
    // Dispatch can return an empty binding list for a script without a Worker.
    // Confirm absence before provisioning; an existing unmarked Worker must
    // still fail the ownership check.
    if (bindings.length === 0) {
      await cfFetch(`${url(env, worker)}/settings`, env.CF_API_TOKEN);
    }
    return bindings;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export function verifyManagedDurableObjectOwnership(
  env: Pick<Env, 'DISPATCH_NAMESPACE'>,
  projectId: string,
  resource: Pick<Resource, 'cf_id' | 'binding_name' | 'metadata'>,
  bindings: ReadonlyArray<{
    name: string;
    type: string;
    text?: unknown;
    class_name?: unknown;
    script_name?: unknown;
    namespace_id?: unknown;
  }>,
): string {
  const owner = bindings.find((binding) => binding.name === OWNER && binding.type === 'plain_text');
  if (owner?.text !== marker(env, projectId, resource.binding_name)) {
    throw new Error(
      'Custom Durable Object ownership differs from this project; refusing to modify it.',
    );
  }
  const binding = bindings.find(
    (value) =>
      value.type === 'durable_object_namespace' &&
      value.class_name === resource.binding_name &&
      (value.script_name === undefined || value.script_name === resource.cf_id),
  );
  if (typeof binding?.namespace_id !== 'string' || !binding.namespace_id) {
    throw new Error('Custom Durable Object namespace is missing.');
  }
  if (
    resource.metadata.namespaceId !== undefined &&
    resource.metadata.namespaceId !== binding.namespace_id
  ) {
    throw new Error('Custom Durable Object namespace changed; refusing to replace its storage.');
  }
  return binding.namespace_id;
}
const verify = verifyManagedDurableObjectOwnership;

function release(bindings: Array<Binding>): string | null {
  const value = bindings.find(
    (binding) => binding.name === RELEASE && binding.type === 'plain_text',
  )?.text;
  if (typeof value !== 'string') {
    throw new Error('Custom Durable Object release identity is missing.');
  }
  return value || null;
}

async function upload(
  env: Env,
  worker: string,
  metadata: Record<string, unknown>,
  modules: ReadonlyArray<WorkerModule>,
  create = false,
): Promise<void> {
  // A release replays the application's modules; stream them like the
  // application upload so the whole bundle is never held in memory.
  const body = workerUploadBody(metadata, modules);
  const watchdog = uploadWatchdog(body.progress, {
    idleMs: WORKER_UPLOAD_IDLE_MS,
    responseMs: WORKER_UPLOAD_RESPONSE_MS,
    // A release sends the application's modules again in one attempt, so it
    // gets as long as the application upload had. A stalled one is still cut
    // by the idle and response limits.
    deadline: Date.now() + WORKER_UPLOAD_BUDGET_MS,
  });
  const failed = (error: unknown) => {
    const timeout = watchdog.fired();
    return (
      body.failure() ??
      (timeout
        ? new Error(`Custom Durable Object upload timed out (${timeout}).`, { cause: error })
        : error)
    );
  };
  try {
    let response: Response;
    try {
      response = await fetch(url(env, worker), {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': body.contentType,
          ...(create ? { 'If-None-Match': '*' } : {}),
        },
        body: withKnownLength(body.stream, body.length),
        signal: watchdog.signal,
      });
    } catch (error) {
      throw failed(error);
    }
    if (create && (response.status === 409 || response.status === 412)) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok) {
      throw new Error(`Custom Durable Object upload failed (HTTP ${response.status}).`);
    }
    let result: { success: boolean };
    try {
      result = (await response.json()) as { success: boolean };
    } catch (error) {
      throw failed(error);
    }
    if (!result.success) {
      throw new Error('Custom Durable Object upload failed.');
    }
  } finally {
    watchdog.dispose();
    body.release();
  }
}

function idle(
  env: Env,
  projectId: string,
  className: string,
  create = false,
): { metadata: Record<string, unknown>; modules: Array<WorkerModule> } {
  return {
    metadata: {
      main_module: ENTRY,
      compatibility_date: '2026-10-01',
      bindings: [
        { type: 'durable_object_namespace', name: 'OBJECT', class_name: className },
        { type: 'plain_text', name: OWNER, text: marker(env, projectId, className) },
        { type: 'plain_text', name: RELEASE, text: '' },
      ],
      ...(create
        ? {
            migrations: {
              new_tag: 'void-durable-v1',
              steps: [{ new_sqlite_classes: [className] }],
            },
          }
        : {}),
    },
    modules: [
      blobWorkerModule(
        ENTRY,
        new Blob(
          [
            `import {DurableObject} from 'cloudflare:workers';\nexport class ${className} extends DurableObject {fetch(){return new Response('Durable Object is inactive',{status:503});}}\nexport default {fetch(){return new Response(null,{status:404});}};`,
          ],
          { type: 'application/javascript+module' },
        ),
      ),
    ],
  };
}

/** Commit ownership before provisioning, then hold the project lock through the provider write. */
export async function prepareManagedDurableObjects(
  env: Env,
  db: Db,
  projectId: string,
  deploymentId: string,
  manifest: DeployManifest,
): Promise<DeployManifest['durableObjects']> {
  const namespaces: Record<string, string> = Object.create(null);
  for (const binding of manifest.durableObjects?.bindings ?? []) {
    const worker = await durableObjectWorkerName(projectId, binding.className);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const existing = (await getProjectResources(tx, projectId)).filter(
        (value) => value.type === 'durable-object',
      );
      if (
        existing.length >= 32 &&
        !existing.some((value) => value.binding_name === binding.className)
      ) {
        throw new Error(
          'This project already has 32 custom Durable Object classes. Removed classes retain storage until the project is deleted.',
        );
      }
      await tx
        .insert(resources)
        .values({
          id: generateId('res'),
          project_id: projectId,
          type: 'durable-object',
          cf_id: worker,
          binding_name: binding.className,
          metadata: { dispatchNamespace: namespace(env) },
        })
        .onConflictDoNothing();
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId));
      const [deployment] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
      if (
        !project ||
        project.status === 'deleting' ||
        !deployment ||
        !['pending', 'uploading', 'migrating', 'cutover'].includes(deployment.status)
      ) {
        throw new Error('deployment canceled');
      }
      const resource = (await getProjectResources(tx, projectId)).find(
        (value) => value.type === 'durable-object' && value.binding_name === binding.className,
      )!;
      if (resource.cf_id !== worker || resource.metadata.dispatchNamespace !== namespace(env)) {
        throw new Error('Custom Durable Object resource identity differs from this installation.');
      }
      let bindings = await readBindings(env, worker);
      if (!bindings) {
        const initial = idle(env, projectId, binding.className, true);
        await upload(env, worker, initial.metadata, initial.modules, true);
        bindings = await readBindings(env, worker);
      }
      if (!bindings) {
        throw new Error('Custom Durable Object was not visible after provisioning.');
      }
      const namespaceId = verify(env, projectId, resource, bindings);
      namespaces[binding.className] = namespaceId;
      await tx
        .update(resources)
        .set({ metadata: { ...resource.metadata, namespaceId } })
        .where(eq(resources.id, resource.id));
    });
  }
  if (!manifest.durableObjects?.bindings.length) {
    return undefined;
  }
  return { bindings: manifest.durableObjects.bindings, runtime: { protocol: 1, namespaces } };
}

export function managedDurableObjectBindings(manifest: DeployManifest): Array<Binding> {
  return (manifest.durableObjects?.bindings ?? []).map((binding) => {
    const namespaceId = manifest.durableObjects?.runtime?.namespaces[binding.className];
    if (!namespaceId) {
      throw new Error('Custom Durable Object storage has not been verified.');
    }
    // Bind the verified namespace directly: cross-script names in a dispatch namespace
    // are not resolved like ordinary Worker names.
    return {
      type: 'durable_object_namespace',
      name: binding.bindingName,
      namespace_id: namespaceId,
    };
  });
}

export async function verifyManagedDurableObjectApplicationBindings(
  env: Env,
  worker: string,
  manifest: DeployManifest,
): Promise<void> {
  if (!manifest.durableObjects?.bindings.length) {
    return;
  }
  const actual = await readBindings(env, worker);
  for (const expected of managedDurableObjectBindings(manifest)) {
    const binding = actual?.find((value) => value.name === expected.name);
    if (binding?.type !== expected.type || binding.namespace_id !== expected.namespace_id) {
      throw new Error('Application custom Durable Object binding could not be verified.');
    }
  }
}

function snapshotKey(projectId: string, deploymentId: string): string {
  return `worker-bundles/${projectId}/${deploymentId}/durable/snapshot.json`;
}

function snapshotModulePrefix(projectId: string, deploymentId: string): string {
  return `worker-bundles/${projectId}/${deploymentId}/durable/modules/`;
}

/** Store the exact code and encrypted bindings before any namespace code can change. */
export async function storeDurableObjectSnapshot(
  env: Env,
  db: Db,
  projectId: string,
  deploymentId: string,
  metadata: Snapshot['metadata'],
  modules: ReadonlyArray<WorkerModule>,
  assetsByHash: ReadonlyMap<string, { bytes: Uint8Array }> = new Map(),
): Promise<void> {
  if (modules.some((module) => module.name === ENTRY)) {
    throw new Error('Reserved custom Durable Object module name.');
  }
  const files: Snapshot['files'] = [];
  for (const [path, asset] of Object.entries(
    (metadata.assetManifest as Record<string, AssetManifestEntry>) ?? {},
  )) {
    if (!path.startsWith('/.void-deploy/')) {
      continue;
    }
    const bytes = assetsByHash.get(asset.hash)?.bytes;
    if (!bytes) {
      throw new Error('Custom Durable Object deployment asset is missing.');
    }
    await putDurableSnapshotObject(
      env.STATIC_ASSETS_R2,
      `worker-bundles/${projectId}/${deploymentId}/durable/assets/${asset.hash}`,
      bytes,
    );
  }
  for (const module of modules) {
    // Stored input modules carry their verified digest; inline modules are
    // hashed from memory. The bytes then stream into the release copy.
    const sha256 = module.sha256 ?? (await streamSha256(await module.open()));
    files.push({ name: module.name, contentType: module.type, sha256 });
    await putDurableSnapshotModule(
      env.STATIC_ASSETS_R2,
      `${snapshotModulePrefix(projectId, deploymentId)}${module.name}`,
      module,
      sha256,
    );
  }
  const credential = await encryptPlatformCredential(
    env,
    projectId,
    `durable:${deploymentId}`,
    JSON.stringify({ metadata, files } satisfies Snapshot),
  );
  await putDurableSnapshotObject(
    env.STATIC_ASSETS_R2,
    snapshotKey(projectId, deploymentId),
    JSON.stringify(credential),
  );
  await db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)));
}

async function loadSnapshot(
  env: Env,
  projectId: string,
  deploymentId: string,
): Promise<{ snapshot: Snapshot; modules: Array<WorkerModule> }> {
  const object = await env.STATIC_ASSETS_R2.get(snapshotKey(projectId, deploymentId));
  if (!object) {
    throw new Error('Custom Durable Object release snapshot is missing.');
  }
  const credential = JSON.parse(await object.text()) as Credential;
  const snapshot = JSON.parse(
    await decryptPlatformCredential(env, projectId, `durable:${deploymentId}`, credential),
  ) as Snapshot;
  // One listing gives every module's size, which the streamed upload
  // declares before it starts. Bytes are checked against the recorded
  // digest as they stream.
  const prefix = snapshotModulePrefix(projectId, deploymentId);
  const stored = await listR2Objects(env.STATIC_ASSETS_R2, prefix);
  const errors = {
    missing: 'Custom Durable Object release module is missing.',
    changed: 'Custom Durable Object release module changed.',
  };
  const modules = snapshot.files.map((file) => {
    const module = stored.get(`${prefix}${file.name}`);
    if (!module) {
      throw new Error(errors.missing);
    }
    return r2WorkerModule(
      env.STATIC_ASSETS_R2,
      {
        name: file.name,
        key: `${prefix}${file.name}`,
        type: file.contentType,
        size: module.size,
        sha256: file.sha256,
      },
      errors,
    );
  });
  return { snapshot, modules };
}

async function restoreObject(
  env: Env,
  projectId: string,
  resource: Resource,
  deploymentId: string | null,
): Promise<void> {
  const current = await readBindings(env, resource.cf_id);
  if (!current) {
    throw new Error('Custom Durable Object Worker is missing.');
  }
  const namespaceId = verify(env, projectId, resource, current);
  if (release(current) === deploymentId) {
    return;
  }
  if (deploymentId === null) {
    const inactive = idle(env, projectId, resource.binding_name);
    await upload(env, resource.cf_id, inactive.metadata, inactive.modules);
  } else {
    const { snapshot, modules } = await loadSnapshot(env, projectId, deploymentId);
    const main = snapshot.metadata.main_module as string;
    const customClasses = snapshot.metadata.customClasses as Record<string, string>;
    const appBindings = await readBindings(env, snapshot.metadata.appWorker as string);
    const proxyToken = appBindings?.find(
      (value) => value.name === '__VOID_PROXY_TOKEN' && value.type === 'plain_text',
    );
    if (typeof proxyToken?.text !== 'string') {
      throw new Error('Application proxy token is missing.');
    }
    const bindings: Array<Binding> = [];
    for (const binding of snapshot.metadata.bindings) {
      if (binding.type !== 'durable_object_namespace') {
        bindings.push(binding.name === '__VOID_PROXY_TOKEN' ? proxyToken : binding);
        continue;
      }
      if (customClasses[binding.name] === resource.binding_name) {
        bindings.push({
          type: binding.type,
          name: binding.name,
          class_name: resource.binding_name,
        });
      } else if (typeof binding.namespace_id === 'string') {
        bindings.push(binding);
      } else {
        const linked = appBindings?.find(
          (entry) =>
            entry.type === binding.type &&
            entry.name === binding.name &&
            entry.class_name === binding.class_name,
        );
        if (typeof linked?.namespace_id !== 'string') {
          throw new Error('Application Durable Object namespace is missing.');
        }
        bindings.push({
          type: binding.type,
          name: binding.name,
          namespace_id: linked.namespace_id,
        });
      }
    }
    const {
      migrations: _migrations,
      assets: originalAssets,
      assetManifest: originalAssetManifest,
      appWorker: _appWorker,
      customClasses: _classes,
      logProject: _logProject,
      ...base
    } = snapshot.metadata;
    // Asset upload tokens belong to a script and expire. Recreate the asset
    // attachment for this Worker, including when replaying an old release.
    let assets: ReturnType<typeof buildAssetMetadata> | undefined;
    if (bindings.some((binding) => binding.type === 'assets')) {
      const assetManifest = originalAssetManifest as Record<string, AssetManifestEntry>;
      const session = await createAssetUploadSession(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        namespace(env),
        resource.cf_id,
        normalizeForCfAssetSession(assetManifest),
      );
      const hashes = [...new Set(session.buckets.flat())];
      const contentTypes = resolveAssetContentTypes(assetManifest, hashes);
      const bytesByHash = new Map<string, { bytes: Uint8Array; contentType: string }>();
      for (const hash of hashes) {
        const object =
          (await env.STATIC_ASSETS_R2.get(`assets/${projectId}/${hash}`)) ??
          (await env.STATIC_ASSETS_R2.get(
            `worker-bundles/${projectId}/${deploymentId}/durable/assets/${hash}`,
          ));
        if (!object) {
          throw new Error('Custom Durable Object release asset is missing.');
        }
        bytesByHash.set(hash, {
          bytes: new Uint8Array(await object.arrayBuffer()),
          contentType: contentTypes.get(hash)!,
        });
      }
      const jwt = await uploadAssetBuckets(
        env.CF_ACCOUNT_ID,
        session.jwt,
        session.buckets,
        bytesByHash,
      );
      assets = buildAssetMetadata(
        jwt,
        (originalAssets as ReturnType<typeof buildAssetMetadata>)?.config,
      );
    }
    await upload(
      env,
      resource.cf_id,
      {
        ...base,
        ...(assets ? { assets } : {}),
        main_module: ENTRY,
        tags: [`void-project:${snapshot.metadata.logProject}`, `void-deployment:${deploymentId}`],
        bindings: [
          ...bindings,
          { type: 'plain_text', name: OWNER, text: marker(env, projectId, resource.binding_name) },
          { type: 'plain_text', name: RELEASE, text: deploymentId },
        ],
      },
      [
        ...modules,
        blobWorkerModule(
          ENTRY,
          new Blob(
            [
              `export {${resource.binding_name}} from ${JSON.stringify('./' + main)};\nexport default {fetch(){return new Response(null,{status:404});}};`,
            ],
            { type: 'application/javascript+module' },
          ),
        ),
      ],
    );
  }
  const after = await readBindings(env, resource.cf_id);
  if (
    !after ||
    verify(env, projectId, resource, after) !== namespaceId ||
    release(after) !== deploymentId
  ) {
    throw new Error('Custom Durable Object publication could not be verified.');
  }
}

/** Called only under the project cutover/rollback lock. Captures undo before each provider write. */
export async function reconcileManagedDurableObjects(
  env: Env,
  db: Db,
  projectId: string,
  deploymentId: string | null,
  manifest: DeployManifest | null,
  recordUndo?: (undo: () => Promise<void>) => void,
): Promise<void> {
  const desired = new Set(
    manifest?.durableObjects?.bindings.map((binding) => binding.className) ?? [],
  );
  for (const resource of await getProjectResources(db, projectId)) {
    if (resource.type !== 'durable-object') {
      continue;
    }
    if (
      resource.cf_id !== (await durableObjectWorkerName(projectId, resource.binding_name)) ||
      resource.metadata.dispatchNamespace !== namespace(env)
    ) {
      throw new Error('Custom Durable Object resource does not belong to this installation.');
    }
    const current = await readBindings(env, resource.cf_id);
    if (!current) {
      throw new Error('Custom Durable Object Worker is missing.');
    }
    const namespaceId = verify(env, projectId, resource, current);
    const expected = manifest?.durableObjects?.runtime?.namespaces[resource.binding_name];
    if (desired.has(resource.binding_name) && expected !== namespaceId) {
      throw new Error('Custom Durable Object release references different storage.');
    }
    const previous = release(current);
    const next = desired.has(resource.binding_name) ? deploymentId : null;
    if (previous === next) {
      continue;
    }
    recordUndo?.(() => restoreObject(env, projectId, resource, previous));
    await restoreObject(env, projectId, resource, next);
    const [deployment] = next
      ? await db.select().from(deployments).where(eq(deployments.id, next))
      : [];
    await db
      .update(resources)
      .set({
        metadata: { ...resource.metadata, proxyTokenGen: deployment?.proxy_token_gen ?? null },
      })
      .where(eq(resources.id, resource.id));
  }
}

export async function deleteManagedDurableObject(
  env: Env,
  projectId: string,
  resource: Pick<Resource, 'cf_id' | 'binding_name' | 'metadata'>,
): Promise<void> {
  const worker = await durableObjectWorkerName(projectId, resource.binding_name);
  if (worker !== resource.cf_id || resource.metadata.dispatchNamespace !== namespace(env)) {
    throw new Error('Custom Durable Object cleanup ownership differs.');
  }
  const bindings = await readBindings(env, worker);
  if (!bindings) {
    return;
  }
  verify(env, projectId, { ...resource, type: 'durable-object' } as Resource, bindings);
  await cfFetch(url(env, worker) + '?force=true', env.CF_API_TOKEN, { method: 'DELETE' });
}
