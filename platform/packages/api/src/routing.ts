import type { ProjectZeroTrustRouting } from '@void/edge';
import { sql as drizzleSql } from 'drizzle-orm';
import { getDomainsByProjectIds, getProject, type Db } from './db.ts';
import type { AssetConfig, DeployManifest } from './types.ts';
import {
  assertRouteBelongsToProject,
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from './zero-trust/routing.ts';

export { computeDispatchLimits } from './routing-limits.ts';

/** Older dispatchers never look in this namespace, so rollback cannot publish previews. */
export function projectRouteKey(project: {
  slug: string;
  preview_client_id?: string | null;
}): string {
  return project.preview_client_id ? 'preview:' + project.slug : project.slug;
}

export function sandboxBlockKey(userId: string): string {
  return `sandbox-block:${userId}`;
}

async function withLockedProjectOwner(
  db: Db,
  projectId: string,
  expectedOwnerUserId: string,
  update: () => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const project = await getProject(tx, projectId);
    if (!project || project.user_id !== expectedOwnerUserId || project.status === 'deleting') {
      return false;
    }
    await update();
    return true;
  });
}

export async function verifyActiveProjectOwner(
  db: Db,
  projectId: string,
  expectedOwnerUserId: string,
): Promise<boolean> {
  return withLockedProjectOwner(db, projectId, expectedOwnerUserId, async () => {});
}

export async function setProjectAiBlock(
  routing: KVNamespace,
  db: Db,
  projectId: string,
  expectedOwnerUserId: string,
  blocked: boolean,
): Promise<boolean> {
  return withLockedProjectOwner(db, projectId, expectedOwnerUserId, async () => {
    if (blocked) {
      await routing.put(`ai-block:${projectId}`, '1');
    } else {
      await routing.delete(`ai-block:${projectId}`);
    }
  });
}

/**
 * A reason-aware mutation of the `suspended` marker on a routing KV entry.
 *
 * The `suspended` field is shared by two unrelated suspension sources with a
 * precedence rule: an admin suspension (`admin_suspended` / a custom reason)
 * outranks an automatic usage suspension (`requests_exceeded`). Usage paths
 * must therefore NEVER clobber an admin marker, while admin actions are
 * authoritative and overwrite/clear anything. The discriminant encodes that:
 *
 *  - `{ op: 'suspend', reason, force }` — set `suspended = reason`. `force`
 *    (admin) overwrites a different existing reason; non-`force` (usage) only
 *    stamps when no marker exists, so it can't downgrade an admin suspension.
 *  - `{ op: 'unsuspend', matchReason }` — clear the marker. `matchReason: null`
 *    (admin) clears any reason; a string (usage) clears ONLY when the existing
 *    marker equals it, so a usage clear can't lift an admin suspension.
 */
export type RoutingSuspensionUpdate =
  | { op: 'suspend'; reason: string; force: boolean }
  | { op: 'unsuspend'; matchReason: string | null };

/**
 * Resolve a routing undo without overwriting a later authoritative mutation.
 * Exact matches restore directly. A suspension-only rewrite still belongs to
 * the attempted deployment, so restore its prior route while carrying the
 * newest `suspended` marker. Mutable owner, plan-limit and Zero Trust metadata
 * do not block the undo either; callers refresh them from PostgreSQL under the
 * project fence. Deployment identity and all other payload fields still match.
 * Any other change (including deletion) wins and suppresses the stale undo.
 */
export function resolveRoutingUndo(
  current: string | null,
  written: string | null,
  previous: string | null,
): { restore: boolean; value: string | null } {
  if (current === written) {
    return { restore: true, value: previous };
  }
  if (current === null || written === null) {
    return { restore: false, value: null };
  }
  try {
    const currentEntry = JSON.parse(current) as Record<string, unknown>;
    const writtenEntry = JSON.parse(written) as Record<string, unknown>;
    const hasCurrentSuspension = Object.hasOwn(currentEntry, 'suspended');
    const currentSuspension = currentEntry.suspended;
    delete currentEntry.suspended;
    delete writtenEntry.suspended;
    delete currentEntry.zeroTrust;
    delete writtenEntry.zeroTrust;
    delete currentEntry.limits;
    delete writtenEntry.limits;
    delete currentEntry.userId;
    delete writtenEntry.userId;
    delete currentEntry.plan;
    delete writtenEntry.plan;
    if (JSON.stringify(currentEntry) !== JSON.stringify(writtenEntry)) {
      return { restore: false, value: null };
    }
    if (previous === null) {
      return { restore: true, value: null };
    }
    const restoredEntry = JSON.parse(previous) as Record<string, unknown>;
    if (hasCurrentSuspension) {
      restoredEntry.suspended = currentSuspension;
    } else {
      delete restoredEntry.suspended;
    }
    return { restore: true, value: JSON.stringify(restoredEntry) };
  } catch {
    return { restore: false, value: null };
  }
}

/**
 * Apply a {@link RoutingSuspensionUpdate} to each given routing KV entry. A
 * project's suspension lives on EVERY routing entry dispatch serves it from —
 * its slug route AND one `domain:<host>` route per active custom domain — so
 * callers pass the full key set (see {@link setProjectsRoutingSuspension}).
 *
 * Skips keys with no entry (a pending domain has no KV route yet; a slug may be
 * mid-deploy), and skips the write whenever the entry already satisfies the
 * update (set → same reason / weaker reason preserved, clear → no matching
 * marker) so repeated suspend/unsuspend is a cheap no-op.
 * Production callers supply the project and its protection read under the
 * project lock, because a stale KV value must never decide protection for a
 * newly published route. A cached route of another project (reused slug or
 * hostname) is left untouched; the remaining keys are still updated, and the
 * first rejection is thrown afterwards so the caller retries.
 */
export async function applyRoutingSuspension(
  routing: KVNamespace,
  keys: ReadonlyArray<string>,
  update: RoutingSuspensionUpdate,
  project?: Readonly<{ id: string; protection: ProjectZeroTrustRouting | null }>,
): Promise<void> {
  let rejected: unknown = null;
  for (const key of keys) {
    const raw = await routing.get(key);
    if (!raw) {
      continue;
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (project) {
      try {
        assertRouteBelongsToProject(entry, project.id);
      } catch (error) {
        rejected ??= error;
        continue;
      }
    }
    if (update.op === 'suspend') {
      if (entry.suspended === update.reason) {
        continue; // already carries this reason
      }
      if (!update.force && entry.suspended) {
        continue; // usage suspend must not overwrite a stronger (admin) reason
      }
      entry.suspended = update.reason;
    } else {
      if (!('suspended' in entry)) {
        continue; // nothing to clear
      }
      if (update.matchReason !== null && entry.suspended !== update.matchReason) {
        continue; // usage clear must not lift a different (admin) reason
      }
      delete entry.suspended;
    }
    const next = JSON.stringify(entry);
    await routing.put(
      key,
      project ? withProjectZeroTrustRouting(next, project.protection, project.id) : next,
    );
  }
  if (rejected) {
    throw rejected;
  }
}

/**
 * Apply a {@link RoutingSuspensionUpdate} across a set of projects' routing
 * entries — each project's slug route plus EVERY `domain:<host>` route the
 * project has. This is the single source of truth for which KV keys carry a
 * project's suspension; dispatch enforces `routing.suspended` on all of them,
 * so suspending only the slug would leave custom domains serving past the cap,
 * and unsuspending only the slug would leave them 429'd.
 *
 * We deliberately do NOT filter to `status === 'active'`. `tryActivateDomain`
 * writes the `domain:<host>` KV route BEFORE flipping the DB row to `active`
 * (self-healing ordering — see provisioning/activate-domain.ts), so a crash in
 * that window leaves a `pending` row whose KV route is already live and served
 * by dispatch. Filtering to active would skip that route and let a suspended
 * project keep serving on the hostname. Fanning out to every domain is safe:
 * {@link applyRoutingSuspension} skips any key with no KV entry, so a pending
 * domain that was never published is just a cheap no-op read.
 *
 * Each project's KV mutation runs under its project-row lock so deploy,
 * rollback, domain lifecycle, and failure compensation cannot overwrite a
 * newer suspension decision with a stale routing snapshot. One project's
 * failure does not stop the others; the first failure is thrown after every
 * project was attempted. No-ops for an empty project list.
 */
export async function setProjectsRoutingSuspension(
  routing: KVNamespace,
  db: Db,
  projects: ReadonlyArray<{
    id: string;
    slug: string;
    user_id: string;
    preview_client_id?: string | null;
  }>,
  update: RoutingSuspensionUpdate,
): Promise<void> {
  if (projects.length === 0) {
    return;
  }
  let failure: unknown = null;
  for (const project of projects) {
    await db
      .transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
        const current = await getProject(tx, project.id);
        // If ownership changed before this lock, transfer convergence owns the
        // route and this stale fan-out must stand down.
        if (!current || current.user_id !== project.user_id || current.status === 'deleting') {
          return;
        }
        // Resolve domains only after the project lock. Domain activation takes
        // the same lock before publishing a route, so this read must happen
        // behind it or a domain activated between the eager read and this lock
        // could escape the suspension entirely.
        const domainMap = await getDomainsByProjectIds(tx, [project.id]);
        const protection = await resolveProjectZeroTrustRoutingForPublication(tx, project.id);
        const domainKeys = (domainMap.get(project.id) ?? []).map(
          (domain) => `domain:${domain.hostname}`,
        );
        const route = projectRouteKey({
          slug: project.slug,
          preview_client_id: current.preview_client_id,
        });
        await applyRoutingSuspension(routing, [route, ...domainKeys], update, {
          id: project.id,
          protection,
        });
      })
      .catch((error: unknown) => {
        failure ??= error;
      });
  }
  if (failure) {
    throw failure;
  }
}

export function buildRoutingJson(opts: {
  privatePreview?: boolean;
  workerName: string;
  projectId: string;
  userId: string;
  manifest: DeployManifest | null;
  deploymentId: string;
  dispatchLimits: { cpuMs?: number; subRequests?: number } | null;
  suspended?: string;
  hasCrons?: boolean;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
  zeroTrust?: ProjectZeroTrustRouting | null;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    ...(opts.privatePreview ? { privatePreview: true } : {}),
    workerName: opts.workerName,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? (manifest?.framework ? 'framework' : 'void'),
    ...(manifest?.ssr ? { ssr: true } : {}),
    ...(manifest?.revalidate ? { revalidate: manifest.revalidate } : {}),
    ...(manifest?.pages?.length ? { pages: manifest.pages } : {}),
    ...(manifest?.pathRevalidate && Object.keys(manifest.pathRevalidate).length > 0
      ? { pathRevalidate: manifest.pathRevalidate }
      : {}),
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.alwaysUseHttps !== undefined ? { alwaysUseHttps: manifest.alwaysUseHttps } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    version: opts.deploymentId,
    ...(opts.dispatchLimits ? { limits: opts.dispatchLimits } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.hasCrons ? { hasCrons: true } : {}),
    ...(opts.assetManifestId ? { assetManifestId: opts.assetManifestId } : {}),
    ...(opts.assetConfig ? { assetConfig: opts.assetConfig } : {}),
    ...(opts.zeroTrust ? { zeroTrust: opts.zeroTrust } : {}),
  });
}

export function buildStaticRoutingJson(opts: {
  privatePreview?: boolean;
  projectId: string;
  userId: string;
  deploymentId: string;
  assetConfig: AssetConfig;
  manifest: DeployManifest | null;
  suspended?: string;
  zeroTrust?: ProjectZeroTrustRouting | null;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    ...(opts.privatePreview ? { privatePreview: true } : {}),
    staticDeploymentId: opts.deploymentId,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? 'static',
    assetConfig: opts.assetConfig,
    version: opts.deploymentId,
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.alwaysUseHttps !== undefined ? { alwaysUseHttps: manifest.alwaysUseHttps } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.zeroTrust ? { zeroTrust: opts.zeroTrust } : {}),
  });
}
