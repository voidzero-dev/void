import {
  denormalizeIsrPath,
  isrCacheKey,
  isrCachePrefix,
  isrCacheVariantPrefix,
  isrEdgeCacheUrl,
  isrEdgeCacheUrlForToken,
  splitIsrCacheKey,
} from '@void/isr';
import { platformProjectHostnames, readPlatformApplication } from '@void/platform';
import type { Context } from 'hono';
import { R2_CONCURRENCY, uploadPool } from './concurrency.ts';
import { getDomainsByProjectId, type Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { resolveCurrentIsrDeployments, type IsrRoutingTarget } from './isr-cache.ts';
import {
  legacyIsrCacheKey,
  legacyIsrCachePrefix,
  legacyIsrCacheVariantPrefix,
} from './isr-legacy-keys.ts';
import { createIsrStore } from './isr-store.ts';
import { purgeZoneCache } from './provisioning/cloudflare-api.ts';

type RevalidateProject = Readonly<{
  slug: string;
  active_deployment_id: string | null;
}>;

type RevalidateRequestBody = Readonly<{
  paths?: ReadonlyArray<string>;
  all?: boolean;
}>;

/**
 * Purge ISR content for a project.
 *
 * The current (`v3`) key shape is host-scoped:
 * `<projectId>/isr/v3/<deploymentId>/<host>/<path>[#rw=<token>]`. The legacy
 * (`v2`) shape is hostless: `<projectId>/isr/v2/<deploymentId>/<path>[#rw=<token>]`.
 * The version segment ENCODES the shape — a `v3` tail always starts with the
 * `<host>` segment, a `v2` tail is the bare path — so no runtime heuristic is
 * needed to tell them apart (see @void/isr `ISR_LEGACY_CACHE_KEY_VERSION` for
 * the aliasing hazard that forced the bump). Dispatch reads/writes `v3` only;
 * the `v2` sweeps below are transition-only and can be deleted once pre-bump
 * entries have aged out.
 *
 * Two-layer purge:
 *   1. R2 body storage plus legacy KV cleanup:
 *      `{all}` — per deployment id in the union, scans TWO disjoint prefixes:
 *        - `<projectId>/isr/v3/<deploymentId>/` (host-scoped): the first tail
 *          segment IS the host, guaranteed by the version.
 *        - `<projectId>/isr/v2/<deploymentId>/` (legacy hostless): the whole
 *          tail is the path; fan the edge purge across every hostname that
 *          resolves to the id (superset purge).
 *      `{paths}` — deletes the exact `v3` host-scoped key (plus its rewrite
 *      variants) for each resolved (hostname, deploymentId) pair, and — once
 *      per (deploymentId, path) — deletes the legacy `v2` hostless direct key
 *      and scans the legacy variant prefix, edge-purging recovered `v2`
 *      variants across every hostname carrying the id.
 *   2. Edge cache — purge URLs of the form
 *      `https://<host>/<path>?__void_isr=<deploymentId>` (+ `__void=json`
 *      variant), one host per key. The edge URL carries NO key version, so the
 *      same URL serves both `v2` and `v3` bodies. `<deploymentId>` is resolved
 *      per-hostname because the slug and custom-domain routing entries may have
 *      drifted apart after a partial-failure deploy (see `deploy.ts` catch
 *      branch that keeps the deploy live when the domain-routing loop fails).
 *
 * The `{paths}` branch issues exactly one `purgeZoneCache` call per invocation
 * (it batches internally at 100 URLs per CF API request); the `{all}` branch
 * flushes per storage list page to bound peak memory (one page ~1000 keys).
 */
export async function runRevalidate(
  context: Context<ApiEnv>,
  projectId: string,
  project: RevalidateProject,
  body: RevalidateRequestBody,
  db: Db = context.get('db'),
): Promise<Response> {
  const application = readPlatformApplication(context.env);
  const cache = createIsrStore(context.env.STATIC_ASSETS_R2, context.env.ISR_CACHE);

  const customDomains = await getDomainsByProjectId(db, projectId);
  // Include `pending` domains, not only `active`. Activation writes the
  // `domain:<host>` KV route BEFORE flipping the DB row to `active`
  // (`activate-domain.ts` — `ROUTING.put` then `updateDomainStatus`), so a
  // crash in that window (documented in `routing.ts`) strands a `pending` row
  // that dispatch is already serving — and ISR-caching — under its own
  // host-scoped keys. `resolveCurrentIsrDeployments` reads each domain's ACTUAL
  // route, so a routed pending host resolves to the real deployment id it
  // points at (correct even after later deploys leave its route on an older
  // id); a never-routed pending host resolves to only the hedge, whose purges
  // are harmless no-ops. Domains are only ever `pending`|`active` (deletion
  // removes the row), so this is every routable host for the project.
  const targets: Array<IsrRoutingTarget> = [
    ...platformProjectHostnames({ id: projectId, slug: project.slug }, application).map(
      (hostname) => ({ hostname, routingKey: project.slug }),
    ),
    ...customDomains.map((d) => ({
      hostname: d.hostname,
      routingKey: `domain:${d.hostname}`,
    })),
  ];

  const { perHostname, union } = await resolveCurrentIsrDeployments(
    context.env.ROUTING,
    targets,
    project.active_deployment_id,
  );

  if (body.all) {
    // Edge purge fans out to `|keys| × 2` URL strings. For high-cardinality
    // projects (tens of thousands of paths, dozens of variants each, multiple
    // hostnames/ids) that array can pin hundreds of MB and OOM the Worker.
    // Flush per storage list page instead so peak memory is bounded by a single
    // page (~1000 keys). CF tolerates duplicate purge URLs across calls, so
    // cross-page dedup loss is fine.
    const pathnameSet = new Set<string>();

    for (const deploymentId of union) {
      // Used by the legacy scan's superset fan-out. Non-empty for every id we
      // scan, since union is built from perHostname's id-sets.
      const hostsForId = hostsResolvingTo(perHostname, deploymentId);

      // --- v3 host-scoped scan: `<host>/<normalizedPath>[#rw=<token>]`. ---
      // The version encodes the shape, so the first tail segment IS the host —
      // no "is this segment a resolved hostname?" heuristic. Dedup direct-hit
      // (host, pathname) within a page; collect variants separately.
      const prefix = isrCachePrefix(projectId, deploymentId);
      let cursor: string | undefined;

      do {
        const listed = await cache.list({ prefix, cursor });
        if (listed.keys.length > 0) {
          const pageDirect = new Map<string, PurgeEdgeTarget>();
          const pageVariants: Array<PurgeEdgeTarget> = [];
          for (const key of listed.keys) {
            const tail = key.name.slice(prefix.length);
            const slashIndex = tail.indexOf('/');
            if (slashIndex === -1) {
              // Malformed v3 key (no `<host>/` segment). Can't derive an edge
              // URL without guessing a host, so skip the edge purge — the storage
              // delete below still wipes it (an `all` purge clears the whole
              // deployment namespace).
              continue;
            }
            const host = tail.slice(0, slashIndex);
            const split = splitIsrCacheKey(tail.slice(slashIndex + 1));
            const pathname = denormalizeIsrPath(split.normalizedPath);
            pathnameSet.add(pathname);
            const dedupKey = `${host}\n${pathname}`;
            if (!pageDirect.has(dedupKey)) {
              pageDirect.set(dedupKey, { host, pathname, deploymentId, variantToken: null });
            }
            if (split.variantToken) {
              pageVariants.push({
                host,
                pathname,
                deploymentId,
                variantToken: split.variantToken,
              });
            }
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => cache.delete(key.name));
          await purgeEdgeCache(context, [...pageDirect.values(), ...pageVariants]);
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);

      // --- v2 legacy scan (TRANSITION-ONLY): `<normalizedPath>[#rw=<token>]`. ---
      // Pre-host-scoping keys are hostless by construction (the whole tail is
      // the path). We can't know which hostname originally served the entry, so
      // fan the edge purge across every hostname resolving to this id (superset
      // purge — a never-cached URL is a harmless CDN no-op). Delete this block
      // once v2 entries have aged out.
      const legacyPrefix = legacyIsrCachePrefix(projectId, deploymentId);
      let legacyCursor: string | undefined;

      do {
        const listed = await cache.list({
          prefix: legacyPrefix,
          cursor: legacyCursor,
        });
        if (listed.keys.length > 0) {
          const pageDirect = new Map<string, PurgeEdgeTarget>();
          const pageVariants: Array<PurgeEdgeTarget> = [];
          for (const key of listed.keys) {
            const split = splitIsrCacheKey(key.name.slice(legacyPrefix.length));
            const pathname = denormalizeIsrPath(split.normalizedPath);
            pathnameSet.add(pathname);
            for (const host of hostsForId) {
              const dedupKey = `${host}\n${pathname}`;
              if (!pageDirect.has(dedupKey)) {
                pageDirect.set(dedupKey, { host, pathname, deploymentId, variantToken: null });
              }
              if (split.variantToken) {
                pageVariants.push({
                  host,
                  pathname,
                  deploymentId,
                  variantToken: split.variantToken,
                });
              }
            }
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => cache.delete(key.name));
          await purgeEdgeCache(context, [...pageDirect.values(), ...pageVariants]);
        }
        legacyCursor = listed.list_complete ? undefined : listed.cursor;
      } while (legacyCursor);
    }

    // `purged` = unique pathnames purged (mirrors what the caller asked for,
    // not the raw count of stored keys deleted across all deployment namespaces).
    return context.json({ purged: pathnameSet.size });
  }

  if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
    return context.json({ error: 'provide `paths` array or `all: true`' }, 400);
  }

  // Purge specific paths. Keys are host-scoped, so resolve the
  // (host, deploymentId) pairs from the per-hostname routing resolution —
  // each hostname only ever wrote keys under its own routing version (plus
  // the active-deployment hedge). A path may have a direct-hit key plus one
  // or more `#rw=<token>` variant keys (requests served via dispatch
  // rewrite); delete every variant and collect the token so the edge cache is
  // purged under the same host.
  const edgeTargets: Array<PurgeEdgeTarget> = [];
  for (const [hostname, ids] of perHostname) {
    for (const deploymentId of ids) {
      for (const path of body.paths) {
        await cache.delete(isrCacheKey(projectId, deploymentId, hostname, path));
        edgeTargets.push({ host: hostname, pathname: path, deploymentId, variantToken: null });

        const variantPrefix = isrCacheVariantPrefix(projectId, deploymentId, hostname, path);
        let cursor: string | undefined;
        do {
          const listed = await cache.list({ prefix: variantPrefix, cursor });
          if (listed.keys.length > 0) {
            for (const key of listed.keys) {
              // `variantPrefix` ends with the `#rw=` separator, so the
              // remainder of the key is exactly the opaque variant token.
              const variantToken = key.name.slice(variantPrefix.length);
              edgeTargets.push({ host: hostname, pathname: path, deploymentId, variantToken });
            }
            await uploadPool(listed.keys, R2_CONCURRENCY, (key) => cache.delete(key.name));
          }
          cursor = listed.list_complete ? undefined : listed.cursor;
        } while (cursor);
      }
    }
  }

  // TRANSITION-ONLY: sweep pre-host-scoping ("legacy") `v2` entries. These live
  // under a hostless namespace `<proj>/isr/v2/<D>/<normalizedPath>[#rw=<token>]`
  // (written before ISR keys grew a `<host>` segment; they persist because ISR
  // puts set no `expirationTtl`). The `v3` scan above (a different key-version
  // prefix) cannot see them, so their direct keys / variant tokens are never
  // reaped and the stale edge entry keeps serving at L1. Delete the orphaned
  // `v2` KV keys and fan any recovered variant's edge purge out to every
  // hostname that resolves to the deployment id (superset purge — a never-cached
  // URL is a harmless CDN no-op). Remove this whole block once v2 entries have
  // aged out.
  //
  // The `v2` namespace is host-INDEPENDENT, so scan it once per
  // (deploymentId, path) over the union of resolved ids — NOT once per hostname
  // (which would issue redundant, identical KV `list` calls).
  //
  // No collision with the `v3` scan: the two live under distinct key-version
  // prefixes (`isr/v3/` vs `isr/v2/`), so neither scan can ever see or delete
  // the other's keys. The legacy DIRECT-key edge URL is already queued by the
  // `v3` direct-hit purge above (`https://<host>/<path>?__void_isr=<D>` carries
  // no key version and is host+path+id identical for every host in hostsForId),
  // so the legacy direct delete only needs to reap the orphaned KV key.
  for (const deploymentId of union) {
    const hostsForId = hostsResolvingTo(perHostname, deploymentId);
    for (const path of body.paths) {
      await cache.delete(legacyIsrCacheKey(projectId, deploymentId, path));

      const legacyVariantPrefix = legacyIsrCacheVariantPrefix(projectId, deploymentId, path);
      let cursor: string | undefined;
      do {
        const listed = await cache.list({ prefix: legacyVariantPrefix, cursor });
        if (listed.keys.length > 0) {
          for (const key of listed.keys) {
            // `legacyVariantPrefix` ends with the `#rw=` separator, so the
            // remainder of the key is exactly the opaque variant token.
            const variantToken = key.name.slice(legacyVariantPrefix.length);
            for (const host of hostsForId) {
              edgeTargets.push({ host, pathname: path, deploymentId, variantToken });
            }
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => cache.delete(key.name));
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    }
  }

  await purgeEdgeCache(context, edgeTargets);
  // `purged` = unique path entries the caller asked for. The per-host storage
  // deletes above are an implementation detail of the drift-handling hedge.
  return context.json({ purged: body.paths.length });
}

function hostsResolvingTo(
  perHostname: ReadonlyMap<string, ReadonlySet<string>>,
  deploymentId: string,
): Array<string> {
  const hosts: Array<string> = [];
  for (const [hostname, ids] of perHostname) {
    if (ids.has(deploymentId)) {
      hosts.push(hostname);
    }
  }
  return hosts;
}

type PurgeEdgeTarget = Readonly<{
  /** Hostname the stored key / edge entry is scoped to. */
  host: string;
  /** Public pathname (denormalized, e.g. `/about`). */
  pathname: string;
  /** Deployment id namespace the key lives under (edge `__void_isr` value). */
  deploymentId: string;
  /**
   * Pre-hashed variant token from the stored key, or null for a direct-hit key.
   * The original URL is not recoverable post-hash; we only need the token to
   * rebuild the matching `__void_orig=<token>` edge cache URL via
   * `isrEdgeCacheUrlForToken`.
   */
  variantToken: string | null;
}>;

async function purgeEdgeCache(
  context: Context<ApiEnv>,
  targets: ReadonlyArray<PurgeEdgeTarget>,
): Promise<void> {
  targets = targets.filter((target) => !target.host.endsWith('.workers.dev'));
  if (targets.length === 0) {
    return;
  }

  try {
    const urls: Array<string> = [];
    for (const { host, pathname, deploymentId, variantToken } of targets) {
      if (variantToken) {
        urls.push(isrEdgeCacheUrlForToken(host, pathname, deploymentId, 'html', variantToken));
        urls.push(isrEdgeCacheUrlForToken(host, pathname, deploymentId, 'json', variantToken));
      } else {
        urls.push(isrEdgeCacheUrl(host, pathname, deploymentId, 'html'));
        urls.push(isrEdgeCacheUrl(host, pathname, deploymentId, 'json'));
      }
    }
    // `purgeZoneCache` batches internally at 100 URLs per CF API request.
    await purgeZoneCache(context.env.CF_ZONE_ID, context.env.CF_API_TOKEN, urls);
  } catch (error) {
    console.error(
      '[api] ISR edge cache purge failed; stale entries may remain until their TTL expires.',
      error,
    );
  }
}
