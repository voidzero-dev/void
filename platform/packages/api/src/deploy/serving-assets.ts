import { KV_THRESHOLD } from '../assets.ts';
import type { AssetManifestEntry } from '../assets.ts';
import type { ApiEnv } from '../env.ts';
import type { DeployManifest, Deployment } from '../types.ts';

export function sortUnique(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

export function parseManifest(raw: string | null | undefined): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

export function parseAssetManifest(raw: string | null): Record<string, AssetManifestEntry> | null {
  if (raw === null || !raw.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, AssetManifestEntry>;
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
  entry: { size?: unknown; store?: unknown },
  manifest: DeployManifest | null,
): 'kv' | 'r2' | null {
  if (entry.store === 'kv' || entry.store === 'r2') {
    return entry.store;
  }
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
    return null;
  }
  // New JSON/direct-upload cutovers persist placement before publishing the
  // ready marker. A v2 row without it is incomplete/corrupt: it may contain a
  // small legacy KV carry-forward, so guessing R2 would publish a broken path.
  if (manifest?.assetManifestVersion === 2) {
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
  assetManifest: Readonly<Record<string, { hash?: unknown; size?: unknown; store?: unknown }>>,
): ServingManifest {
  const deployManifest = parseManifest(deployment.manifest);
  const servingManifest: Record<string, string> = {};
  const invalid: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    if (path.startsWith('/.void-deploy/')) {
      continue;
    }
    const store = inferPersistedAssetStore(entry, deployManifest);
    if (typeof entry.hash !== 'string' || !store) {
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
  const assetManifest = deployment.asset_hashes
    ? (JSON.parse(deployment.asset_hashes) as Record<string, { hash?: unknown }>)
    : null;
  if (!assetManifest || Object.keys(assetManifest).length === 0) {
    return;
  }
  const servingManifestKey = `manifest:${deployment.id}`;
  const servingManifestRaw = await env.ROUTING.get(servingManifestKey);
  let servingManifest: Record<string, string>;
  if (servingManifestRaw) {
    servingManifest = JSON.parse(servingManifestRaw) as Record<string, string>;
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
  attachServingStoreMetadata(assetManifest as Record<string, AssetManifestEntry>, servingManifest);
}
