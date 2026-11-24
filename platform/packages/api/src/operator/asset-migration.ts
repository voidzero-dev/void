import { extname } from 'node:path';
import { count, eq, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  computeAssetHash,
  computeAssetStreamHashes,
  getContentType,
  KV_THRESHOLD,
} from '../assets.ts';
import { getActiveDeployment, getDeployment, getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { deployments, projects } from '../schema.ts';
import { OperatorError, preview } from './common.ts';

const MAX_ASSETS = 8;
const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{32}$/;
type Entry = { hash: string; size: number; store?: 'kv' | 'r2'; scope?: 'project' };
type Asset = { hash: string; size: number; paths: Array<string>; store: 'kv' | 'r2' };

function invalid(message: string): never {
  throw new OperatorError(409, message, 'asset_migration_unverified');
}
function record(raw: string | null, label: string): Record<string, unknown> {
  if (raw === null) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* Report the same actionable error for malformed persisted data. */
  }
  return invalid(`${label} is invalid; investigate this deployment before migrating assets.`);
}

async function snapshot(context: Context<ApiEnv>, deploymentId: string, db = context.get('db')) {
  const deployment = await getDeployment(db, deploymentId);
  if (!deployment) {
    throw new OperatorError(404, 'Deployment not found.', 'not_found');
  }
  const project = await getProject(db, deployment.project_id);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  if (project.status === 'deleting' || (await getActiveDeployment(db, project.id))) {
    throw new OperatorError(
      409,
      'Wait for project deployment, rollback, recovery, or deletion to finish before migrating assets.',
      'project_busy',
    );
  }
  if (
    project.active_deployment_id !== deploymentId &&
    !deployment.retained &&
    !deployment.bundle_stored
  ) {
    throw new OperatorError(
      409,
      'Only active deployments, retained rollback targets, and stored Worker bundles can be migrated.',
      'deployment_unprotected',
    );
  }
  const servingRaw = await context.env.ROUTING.get(`manifest:${deploymentId}`);
  const entries = record(deployment.asset_hashes, 'The persisted asset manifest');
  const serving = record(servingRaw, 'The serving asset manifest');
  const manifest = record(deployment.manifest, 'The deployment manifest');
  const assets = new Map<string, Asset>();
  for (const path of Object.keys(serving)) {
    if (!Object.hasOwn(entries, path)) {
      invalid(`Serving path ${path} has no persisted hash and size.`);
    }
  }
  for (const [path, value] of Object.entries(entries)) {
    if (path.startsWith('/.void-deploy/')) {
      continue;
    }
    if (!path.startsWith('/') || !value || typeof value !== 'object' || Array.isArray(value)) {
      invalid(`Asset ${path} has invalid metadata.`);
    }
    const entry = value as Entry;
    if (!HASH.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      invalid(`Asset ${path} has invalid hash or size metadata.`);
    }
    const route = serving[path];
    let store: 'kv' | 'r2';
    if (route !== undefined) {
      if (route !== entry.hash && route !== `!${entry.hash}`) {
        invalid(`Serving path ${path} disagrees with its persisted content hash.`);
      }
      // The serving manifest is authoritative. Keeping both originals lets a
      // retry reconcile a DB/KV acknowledgement interrupted during publication.
      store = route === entry.hash ? 'kv' : 'r2';
    } else if (entry.store === 'kv' || entry.store === 'r2') {
      store = entry.store;
    } else if (manifest.assetManifestVersion !== 2) {
      store = entry.size >= KV_THRESHOLD ? 'r2' : 'kv';
    } else {
      invalid(
        `Asset ${path} has no verified placement. Restore its serving manifest before migration.`,
      );
    }
    const prior = assets.get(entry.hash);
    if (prior && (prior.size !== entry.size || prior.store !== store)) {
      invalid(`Hash ${entry.hash} has conflicting size or placement.`);
    }
    if (prior) {
      prior.paths.push(path);
    } else {
      assets.set(entry.hash, { hash: entry.hash, size: entry.size, store, paths: [path] });
    }
    // Reconstruct the whole manifest before publishing any bounded page. A
    // missing historical manifest must not hide the untouched later pages.
    // KV can return an older manifest on the next page. Durable scope proof
    // from a verified page must keep that page on R2 when publishing again.
    if (entry.store === 'r2' && entry.scope === 'project') {
      serving[path] = `!${entry.hash}`;
    } else {
      serving[path] ??= store === 'r2' ? `!${entry.hash}` : entry.hash;
    }
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      deploymentId,
      active: project.active_deployment_id,
      retained: deployment.retained,
      bundleStored: deployment.bundle_stored,
      status: deployment.status,
      assetHashes: deployment.asset_hashes,
      manifest: deployment.manifest,
      servingRaw,
    }),
  );
  const expected = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
  return {
    deployment,
    project,
    entries,
    serving,
    assets: [...assets.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    expected,
  };
}

function batchFor(assets: Array<Asset>, entries: Record<string, unknown>, cursor?: string) {
  if (
    cursor !== undefined &&
    (!HASH.test(cursor) || !assets.some((asset) => asset.hash === cursor))
  ) {
    throw new OperatorError(
      400,
      'The cursor must be a content hash from this deployment.',
      'invalid_cursor',
    );
  }
  if (
    cursor !== undefined &&
    assets.some(
      (asset) =>
        asset.hash <= cursor &&
        asset.paths.some((path) => {
          const entry = entries[path] as Entry;
          return entry.store !== 'r2' || entry.scope !== 'project';
        }),
    )
  ) {
    throw new OperatorError(
      409,
      'The cursor skips assets that have not been migrated. Restart without a cursor.',
      'invalid_cursor',
    );
  }
  const pending = assets.filter((asset) => cursor === undefined || asset.hash > cursor);
  const batch: Array<Asset> = [];
  let bytes = 0;
  for (const asset of pending) {
    if (batch.length === MAX_ASSETS || (batch.length > 0 && bytes + asset.size > MAX_BYTES)) {
      break;
    }
    batch.push(asset);
    bytes += asset.size;
  }
  const complete = batch.length === pending.length;
  return { batch, bytes, complete, nextCursor: complete ? null : batch.at(-1)!.hash };
}

function verify(bytes: ArrayBuffer, asset: Asset) {
  const extensions = new Map(asset.paths.map((path) => [extname(path), path]));
  if (
    bytes.byteLength !== asset.size ||
    [...extensions.values()].some((path) => computeAssetHash(bytes, path) !== asset.hash)
  ) {
    invalid(
      `Asset ${asset.paths[0]} failed content hash or size verification. No serving metadata was changed.`,
    );
  }
}

async function verifyObject(object: R2ObjectBody, asset: Asset) {
  const result = await computeAssetStreamHashes(
    object.body as ReadableStream<Uint8Array>,
    asset.paths,
    asset.size,
  );
  if (result.size !== asset.size || result.hashes.some((hash) => hash !== asset.hash)) {
    invalid(
      `Asset ${asset.paths[0]} failed content hash or size verification. No serving metadata was changed.`,
    );
  }
}

async function copyAsset(context: Context<ApiEnv>, projectId: string, asset: Asset) {
  const r2 = context.env.STATIC_ASSETS_R2;
  const key = `assets/${projectId}/${asset.hash}`;
  const existing = await r2.get(key);
  if (existing) {
    await verifyObject(existing, asset);
    return false;
  }
  let bytes: ArrayBuffer | ReadableStream<Uint8Array>;
  let httpMetadata: R2HTTPMetadata | undefined;
  if (asset.store === 'r2') {
    const source = await r2.get(`assets/${asset.hash}`);
    if (!source) {
      invalid(`Asset ${asset.paths[0]} is missing from its serving R2 store.`);
    }
    httpMetadata = source.httpMetadata;
    await verifyObject(source, asset);
    const transfer = await r2.get(`assets/${asset.hash}`, {
      onlyIf: { etagMatches: source.etag },
    });
    if (!transfer || !('body' in transfer)) {
      invalid(`Asset ${asset.paths[0]} changed while being copied. Preview again.`);
    }
    bytes = transfer.body;
  } else {
    const source = await context.env.STATIC_ASSETS.getWithMetadata<{ ct?: string }>(
      key,
      'arrayBuffer',
    );
    const legacy =
      source.value === null
        ? await context.env.STATIC_ASSETS.getWithMetadata<{ ct?: string }>(
            `assets/${asset.hash}`,
            'arrayBuffer',
          )
        : source;
    if (legacy.value === null) {
      invalid(`Asset ${asset.paths[0]} is missing from its serving KV store.`);
    }
    bytes = legacy.value;
    httpMetadata = { contentType: legacy.metadata?.ct ?? getContentType(asset.paths[0]) };
    verify(bytes, asset);
  }
  // Never overwrite a concurrently uploaded object. Its bytes must be checked
  // even when this create-only write loses the race or acknowledgement.
  await r2.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata });
  const written = await r2.get(key);
  if (!written) {
    invalid(`Copied asset ${asset.paths[0]} could not be read back.`);
  }
  await verifyObject(written, asset);
  return true;
}

/** Copy a bounded page, then publish under the same project fence as cutover/GC. */
export async function migrateOperatorDeploymentAssets(
  context: Context<ApiEnv>,
  deploymentId: string,
  dryRun: boolean,
  cursor?: string,
  expected?: unknown,
) {
  const initial = await snapshot(context, deploymentId);
  const page = batchFor(initial.assets, initial.entries, cursor);
  const summary = {
    projectId: initial.project.id,
    cursor: cursor ?? null,
    totalAssets: initial.assets.length,
    assets: page.batch.length,
    bytes: page.bytes,
    complete: page.complete,
    nextCursor: page.nextCursor,
    sources: {
      kv: page.batch.filter((asset) => asset.store === 'kv').length,
      r2: page.batch.filter((asset) => asset.store === 'r2').length,
    },
    originalsRetained: true,
  };
  if (dryRun) {
    return preview('deployment.migrate-assets', deploymentId, {
      ...summary,
      expected: initial.expected,
    });
  }
  if (expected !== initial.expected) {
    throw new OperatorError(
      409,
      'The asset migration plan changed. Preview this deployment again.',
      'preview_changed',
    );
  }
  let copied = 0;
  // Serial processing bounds memory and requests. An oversized R2 object gets
  // its own streaming page, without holding a database connection during copy.
  for (const asset of page.batch) {
    if (await copyAsset(context, initial.project.id, asset)) {
      copied++;
    }
  }
  await context.get('db').transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${initial.project.id} FOR UPDATE`);
    const fresh = await snapshot(context, deploymentId, tx);
    if (fresh.expected !== initial.expected) {
      throw new OperatorError(
        409,
        'Project or deployment state changed during copying. Preview again; original assets are preserved.',
        'preview_changed',
      );
    }
    for (const asset of page.batch) {
      for (const path of asset.paths) {
        fresh.entries[path] = { ...(fresh.entries[path] as Entry), store: 'r2', scope: 'project' };
        fresh.serving[path] = `!${asset.hash}`;
      }
    }
    await tx
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(fresh.entries) })
      .where(eq(deployments.id, deploymentId));
    await context.env.ROUTING.put(`manifest:${deploymentId}`, JSON.stringify(fresh.serving));
  });
  return {
    dryRun: false,
    action: 'deployment.migrate-assets',
    target: deploymentId,
    ...summary,
    copied,
    verified: page.batch.length,
  };
}

/** Metadata inventory includes every active pointer and retained/stored rollback target. */
export async function assetMigrationInventory(
  context: Context<ApiEnv>,
  options: { page: number; limit: number; offset: number },
) {
  const db = context.get('db');
  const where = or(
    eq(deployments.id, projects.active_deployment_id),
    eq(deployments.retained, true),
    eq(deployments.bundle_stored, true),
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: deployments.id,
        projectId: projects.id,
        slug: projects.slug,
        activeId: projects.active_deployment_id,
        retained: deployments.retained,
        bundleStored: deployments.bundle_stored,
        assetHashes: deployments.asset_hashes,
      })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.project_id))
      .where(where)
      .orderBy(deployments.id)
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ total: count() })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.project_id))
      .where(where),
  ]);
  const inventory = [];
  for (const row of rows) {
    let assets = 0;
    let needsMigration = 0;
    let invalidMetadata = false;
    try {
      const entries = record(row.assetHashes, 'The persisted asset manifest');
      const serving = record(
        await context.env.ROUTING.get(`manifest:${row.id}`),
        'The serving asset manifest',
      );
      const hashes = new Map<string, { size: number; store: string | undefined }>();
      for (const path of Object.keys(serving)) {
        if (!Object.hasOwn(entries, path)) {
          invalidMetadata = true;
        }
      }
      for (const [path, value] of Object.entries(entries)) {
        if (path.startsWith('/.void-deploy/')) {
          continue;
        }
        assets++;
        if (!path.startsWith('/') || !value || typeof value !== 'object' || Array.isArray(value)) {
          invalidMetadata = true;
          continue;
        }
        const entry = value as Entry;
        if (
          !HASH.test(entry.hash) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          (serving[path] !== undefined &&
            serving[path] !== entry.hash &&
            serving[path] !== `!${entry.hash}`)
        ) {
          invalidMetadata = true;
        }
        const store =
          serving[path] === undefined
            ? entry.store
            : typeof serving[path] === 'string' && serving[path].startsWith('!')
              ? 'r2'
              : 'kv';
        const prior = hashes.get(entry.hash);
        if (prior && (prior.size !== entry.size || prior.store !== store)) {
          invalidMetadata = true;
        }
        hashes.set(entry.hash, { size: entry.size, store });
        if (
          entry.store !== 'r2' ||
          entry.scope !== 'project' ||
          serving[path] !== `!${entry.hash}`
        ) {
          needsMigration++;
        }
      }
    } catch {
      invalidMetadata = true;
    }
    inventory.push({
      id: row.id,
      projectId: row.projectId,
      slug: row.slug,
      active: row.activeId === row.id,
      retained: row.retained,
      bundleStored: row.bundleStored,
      assets,
      needsMigration,
      invalid: invalidMetadata,
    });
  }
  const total = totals[0]?.total ?? 0;
  return {
    deployments: inventory,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}
