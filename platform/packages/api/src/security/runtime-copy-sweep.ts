/**
 * Listing and deleting runtime copies by name (design doc 0095, M30). Only the Cloudflare
 * API: the API's result path, the hourly reaper and uninstall share it.
 */
import { CF_API_BASE, cfFetch, CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import { runtimeCopyStoreOwner } from './runtime-copy-names.ts';

export type SecurityCopyTarget = Readonly<{
  accountId: string;
  apiToken: string;
  /** Dispatch namespace of this installation's copies. */
  namespace: string;
  sandbox: string;
  /** Every copy resource name of this installation starts with it. */
  prefix: string;
}>;

export function securityCopyScriptUrl(target: SecurityCopyTarget, script: string): string {
  return `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces/${target.namespace}/scripts/${script}`;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

export type CreatedStore = { kind: 'd1' | 'kv' | 'r2'; name: string; id: string };

export async function deleteStore(target: SecurityCopyTarget, store: CreatedStore): Promise<void> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  const url =
    store.kind === 'd1'
      ? `${base}/d1/database/${store.id}`
      : store.kind === 'kv'
        ? `${base}/storage/kv/namespaces/${store.id}`
        : `${base}/r2/buckets/${store.name}`;
  try {
    await cfFetch(url, target.apiToken, { method: 'DELETE' });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function deleteCopyScript(target: SecurityCopyTarget, script: string): Promise<void> {
  try {
    await cfFetch(`${securityCopyScriptUrl(target, script)}?force=true`, target.apiToken, {
      method: 'DELETE',
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export type SecurityCopyResources = Readonly<{
  scripts: ReadonlyArray<string>;
  stores: ReadonlyArray<CreatedStore>;
}>;

const PAGE = 100;

/** Every resource whose name starts with `namePart` (the prefix, or one copy's script). */
export async function listSecurityRuntimeCopyResources(
  target: SecurityCopyTarget,
  namePart: string,
): Promise<SecurityCopyResources> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  let scripts: Array<{ id?: unknown }> = [];
  try {
    scripts = await cfFetch<Array<{ id?: unknown }>>(
      `${base}/workers/dispatch/namespaces/${target.namespace}/scripts`,
      target.apiToken,
    );
  } catch (error) {
    // No copy namespace (none yet, or uninstall already removed it): stores may still be left.
    if (!isNotFound(error)) {
      throw error;
    }
  }
  const mine = (name: unknown): name is string =>
    typeof name === 'string' && name.startsWith(namePart);
  const stores: Array<CreatedStore> = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await cfFetch<Array<{ uuid?: unknown; name?: unknown }>>(
      `${base}/d1/database?name=${encodeURIComponent(namePart)}&per_page=${PAGE}&page=${page}`,
      target.apiToken,
    );
    for (const row of rows) {
      if (mine(row.name) && typeof row.uuid === 'string') {
        stores.push({ kind: 'd1', name: row.name, id: row.uuid });
      }
    }
    if (rows.length < PAGE) {
      break;
    }
  }
  for (let page = 1; page <= 50; page++) {
    const rows = await cfFetch<Array<{ id?: unknown; title?: unknown }>>(
      `${base}/storage/kv/namespaces?per_page=${PAGE}&page=${page}`,
      target.apiToken,
    );
    for (const row of rows) {
      if (mine(row.title) && typeof row.id === 'string') {
        stores.push({ kind: 'kv', name: row.title, id: row.id });
      }
    }
    if (rows.length < PAGE) {
      break;
    }
  }
  const buckets = await cfFetch<{ buckets?: Array<{ name?: unknown }> }>(
    `${base}/r2/buckets?name_contains=${encodeURIComponent(namePart)}&per_page=1000`,
    target.apiToken,
  );
  for (const bucket of buckets?.buckets ?? []) {
    if (mine(bucket.name)) {
      stores.push({ kind: 'r2', name: bucket.name, id: bucket.name });
    }
  }
  return {
    scripts: scripts.map((script) => script.id).filter(mine),
    stores,
  };
}

/**
 * Deletes every copy resource of this installation whose copy script is not in `keep`:
 * scripts first (nothing can use a store once its script is gone), then the stores.
 * Returns the copies deleted.
 *
 * `keep` may be a function: it is called only after the listing, so a scan that starts
 * while the lists are read is still kept (the reaper reads the running scans then).
 */
export async function sweepSecurityRuntimeCopies(
  target: SecurityCopyTarget,
  keep: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  namePart: string = target.prefix,
): Promise<number> {
  const found = await listSecurityRuntimeCopyResources(target, namePart);
  const kept = typeof keep === 'function' ? await keep() : keep;
  return deleteListedCopies(target, found, kept);
}

async function deleteListedCopies(
  target: SecurityCopyTarget,
  found: SecurityCopyResources,
  keep: ReadonlySet<string>,
): Promise<number> {
  const scripts = found.scripts.filter((script) => !keep.has(script));
  for (const script of scripts) {
    await deleteCopyScript(target, script);
  }
  const stores = found.stores.filter((store) => !keep.has(runtimeCopyStoreOwner(store.name)));
  const results = await Promise.allSettled(stores.map((store) => deleteStore(target, store)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    throw (failed as PromiseRejectedResult).reason;
  }
  return new Set([...scripts, ...stores.map((store) => runtimeCopyStoreOwner(store.name))]).size;
}

type ScriptBinding = {
  type?: unknown;
  id?: unknown;
  namespace_id?: unknown;
  bucket_name?: unknown;
};

/**
 * One copy, without listing the account: the script's own bindings name its stores, so
 * the script is read, deleted, then exactly those stores. No script means no copy was
 * uploaded for this attempt (most scans: other engines, static apps); stores a crash left
 * before the upload are the hourly reaper's.
 */
export async function deleteSecurityRuntimeCopy(
  target: SecurityCopyTarget,
  script: string,
): Promise<void> {
  let bindings: Array<ScriptBinding>;
  try {
    const settings = await cfFetch<{ bindings?: Array<ScriptBinding> }>(
      `${securityCopyScriptUrl(target, script)}/settings`,
      target.apiToken,
    );
    bindings = settings?.bindings ?? [];
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  const own = `${script}-`;
  const stores: Array<CreatedStore> = [];
  for (const binding of bindings) {
    if (binding.type === 'd1' && typeof binding.id === 'string') {
      stores.push({ kind: 'd1', name: own, id: binding.id });
    } else if (binding.type === 'kv_namespace' && typeof binding.namespace_id === 'string') {
      stores.push({ kind: 'kv', name: own, id: binding.namespace_id });
    } else if (
      binding.type === 'r2_bucket' &&
      typeof binding.bucket_name === 'string' &&
      binding.bucket_name.startsWith(own)
    ) {
      stores.push({ kind: 'r2', name: binding.bucket_name, id: binding.bucket_name });
    }
  }
  await deleteCopyScript(target, script);
  const results = await Promise.allSettled(
    stores.map(async (store) => {
      // A D1 or KV binding names only an id: its name must prove it is this copy's.
      if (store.kind !== 'r2' && !(await storeNamedFor(target, store, own))) {
        return;
      }
      await deleteStore(target, store);
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    throw (failed as PromiseRejectedResult).reason;
  }
}

async function storeNamedFor(
  target: SecurityCopyTarget,
  store: CreatedStore,
  own: string,
): Promise<boolean> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  try {
    if (store.kind === 'd1') {
      const db = await cfFetch<{ name?: unknown }>(
        `${base}/d1/database/${store.id}`,
        target.apiToken,
      );
      return typeof db?.name === 'string' && db.name.startsWith(own);
    }
    const ns = await cfFetch<{ title?: unknown }>(
      `${base}/storage/kv/namespaces/${store.id}`,
      target.apiToken,
    );
    return typeof ns?.title === 'string' && ns.title.startsWith(own);
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}
