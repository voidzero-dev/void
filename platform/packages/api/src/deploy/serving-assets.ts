import { isRecord } from '@void/deploy-core';
import { KV_THRESHOLD } from '../assets.ts';
import type { AssetManifestEntry } from '../assets.ts';
import type { ApiEnv } from '../env.ts';
import { readServingAssetManifest } from '../routing-records.ts';
import type { Deployment } from '../types.ts';

export function sortUnique(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function isAssetManifestEntry(value: unknown): value is AssetManifestEntry {
  return (
    isRecord(value) &&
    typeof value.hash === 'string' &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    (value.store === undefined || value.store === 'kv' || value.store === 'r2') &&
    (value.scope === undefined || value.scope === 'project')
  );
}

function isAssetManifest(value: unknown): value is AssetManifest {
  return isRecord(value) && Object.values(value).every(isAssetManifestEntry);
}

export function parseAssetManifest(raw: string | null): Record<string, AssetManifestEntry> | null {
  if (raw === null || !raw.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAssetManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function equalAssetManifests(
  a: Record<string, AssetManifestEntry> | null,
  b: Record<string, AssetManifestEntry> | null,
): boolean {
  if (!a || !b) {
    return false;
  }
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  for (const [path, entry] of aEntries) {
    const other = b[path];
    if (!other || other.hash !== entry.hash || other.size !== entry.size) {
      return false;
    }
  }
  return true;
}

export class StaticAssetDisappearedError extends Error {
  constructor(hashes: ReadonlyArray<string>) {
    super(`static assets disappeared before cutover: ${hashes.slice(0, 10).join(', ')}`);
    this.name = 'StaticAssetDisappearedError';
  }
}

function inferPersistedAssetStore(
  entry: AssetManifestEntry,
  requiresPersistedStore: boolean,
): 'kv' | 'r2' | null {
  if (entry.store !== undefined) {
    return entry.store;
  }
  // New JSON/direct-upload cutovers persist placement before publishing the
  // ready marker. A v2 row without it is incomplete/corrupt: it may contain a
  // small legacy KV carry-forward, so guessing R2 would publish a broken path.
  if (requiresPersistedStore) {
    return null;
  }
  // Older multipart deployments did not persist placement and deterministically
  // used the static uploader's 2 MiB size split.
  return entry.size >= KV_THRESHOLD ? 'r2' : 'kv';
}

interface AssetManifest {
  [key: string]: AssetManifestEntry;
}

export function attachServingStoreMetadata(
  assetManifest: Readonly<Record<string, AssetManifestEntry>>,
  servingManifest: Readonly<Record<string, string>>,
  scopedR2 = false,
): AssetManifest {
  const persisted: Record<string, AssetManifestEntry> = {};
  const missing: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    if (path.startsWith('/.void-deploy/')) {
      persisted[path] = entry;
      continue;
    }
    const serving = servingManifest[path];
    const hash = serving?.startsWith('!') ? serving.slice(1) : serving;
    if (!serving || hash !== entry.hash) {
      missing.push(path);
      continue;
    }
    persisted[path] = {
      ...entry,
      store: serving.startsWith('!') ? 'r2' : 'kv',
      ...(scopedR2 ? { scope: 'project' as const } : {}),
    };
  }
  if (missing.length > 0) {
    throw new StaticAssetDisappearedError(missing);
  }
  return persisted;
}

interface ServingManifest {
  [key: string]: string;
}

function reconstructPersistedServingManifest(
  deployment: Deployment,
  assetManifest: Readonly<AssetManifest>,
): ServingManifest {
  const deployManifest: unknown = deployment.manifest ? JSON.parse(deployment.manifest) : null;
  const requiresPersistedStore =
    isRecord(deployManifest) && deployManifest.assetManifestVersion === 2;
  const servingManifest: Record<string, string> = {};
  const invalid: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    if (path.startsWith('/.void-deploy/')) {
      continue;
    }
    const store = inferPersistedAssetStore(entry, requiresPersistedStore);
    if (!store) {
      invalid.push(path);
      continue;
    }
    servingManifest[path] = store === 'r2' ? `!${entry.hash}` : entry.hash;
  }
  if (invalid.length > 0) {
    throw new StaticAssetDisappearedError(invalid);
  }
  return servingManifest;
}

export async function assertPersistedDeploymentServingAssetsExist(
  env: ApiEnv['Bindings'],
  deployment: Deployment,
): Promise<void> {
  if (!deployment.asset_hashes) {
    return;
  }
  const assetManifest = parseAssetManifest(deployment.asset_hashes);
  if (!assetManifest) {
    throw new Error('Invalid persisted deployment asset manifest');
  }
  if (Object.keys(assetManifest).length === 0) {
    return;
  }
  const servingManifestKey = `manifest:${deployment.id}`;
  const servingManifestRaw = await env.ROUTING.get(servingManifestKey);
  let servingManifest: Record<string, string>;
  if (servingManifestRaw) {
    const persisted = readServingAssetManifest(servingManifestRaw);
    if (!persisted) {
      throw new Error('Invalid persisted serving manifest');
    }
    servingManifest = persisted;
  } else {
    // The ready marker and serving manifest are separate KV keys and can
    // propagate at different speeds. Reconstruct a missing read from the
    // durable path/hash manifest instead of compensating a healthy cutover
    // merely because this colo saw `ready` first. New rows persist placement;
    // legacy multipart rows deterministically used the 2 MiB KV/R2 split.
    servingManifest = reconstructPersistedServingManifest(deployment, assetManifest);
    await env.ROUTING.put(servingManifestKey, JSON.stringify(servingManifest));
  }
  // Verify metadata coherence, not object-store presence. Platform GC is
  // serialized on the project row and protects every nonterminal deployment;
  // legacy unscoped keys are never collected. Out-of-band bucket deletion
  // cannot be diagnosed with bounded per-request probes for a 5,000-file app.
  attachServingStoreMetadata(assetManifest, servingManifest);
}
