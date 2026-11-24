import { hmacSignState } from '../auth/hmac.ts';
import { getDispatchWorkerProxyToken } from '../provisioning/cloudflare-api.ts';
import type { ProxyTokenLookup } from '../provisioning/cloudflare-api.ts';

export type BackfillQueueTokensOptions = Readonly<{
  accountId: string;
  apiToken: string;
  dispatchNamespace: string;
  jwtSecret: string;
  /** Validate every candidate without writing to KV. */
  dryRun?: boolean;
  /**
   * Override for tests. When set, replaces the live CF API call that
   * reads `__VOID_PROXY_TOKEN` from the target worker's bindings.
   */
  fetchToken?: (workerName: string) => Promise<ProxyTokenLookup>;
}>;

export type BackfillQueueTokensResult = Readonly<{
  scanned: number;
  wouldUpdate?: number;
  updated: number;
  skipped: number;
  /**
   * Count of entries we skipped because a concurrent writer (deploy or
   * rollback) had modified the KV value between our initial read and
   * the final put. Operators can re-run the backfill to sweep these up
   * once the concurrent operation completes.
   */
  raced: number;
  /**
   * Count of entries we skipped because the CF bindings read threw a
   * transient/error response (rate limit, network, 5xx). Operators can
   * re-run the backfill once the underlying CF issue resolves.
   * Intentionally separated from `skipped` so a transient incident
   * cannot masquerade as a successful migration.
   */
  errored: number;
}>;

type QueueRoutingEntry = Readonly<{
  workerName?: string;
  projectId?: string;
  queueName?: string;
  proxyToken?: string;
  [key: string]: unknown;
}>;

/**
 * Iterate every `queue:*` KV entry and stamp `proxyToken` on any entry
 * written before the dispatch relay started forwarding
 * `x-void-internal`. The stamped token is read from the target worker's
 * `__VOID_PROXY_TOKEN` binding so it survives `JWT_SECRET` rotation —
 * a freshly `hmacSignState(projectId, currentSecret)` value would 401
 * any worker deployed before the rotation.
 *
 * Concurrency-safe-ish: each entry is re-read immediately before the
 * put; if the value changed we skip the write so a concurrent deploy
 * cannot be clobbered. This is not a true compare-and-swap (KV has
 * no CAS primitive) but it shrinks the race window from the full
 * backfill duration to a single tick.
 */
export async function backfillQueueTokens(
  routing: KVNamespace,
  opts: BackfillQueueTokensOptions,
): Promise<BackfillQueueTokensResult> {
  const fetchToken =
    opts.fetchToken ??
    ((workerName: string) =>
      getDispatchWorkerProxyToken(
        opts.accountId,
        opts.apiToken,
        opts.dispatchNamespace,
        workerName,
      ));

  let scanned = 0;
  let updated = 0;
  let wouldUpdate = 0;
  let skipped = 0;
  let raced = 0;
  let errored = 0;

  let cursor: string | undefined;
  do {
    const page = await routing.list({ prefix: 'queue:', ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) {
      scanned++;
      const snapshotRaw = await routing.get(name);
      if (!snapshotRaw) {
        skipped++;
        continue;
      }
      let entry: QueueRoutingEntry;
      try {
        entry = JSON.parse(snapshotRaw) as QueueRoutingEntry;
      } catch {
        skipped++;
        continue;
      }
      if (entry.proxyToken) {
        skipped++;
        continue;
      }
      if (!entry.workerName) {
        // Without a workerName there is no binding to read the token from.
        skipped++;
        continue;
      }

      const lookup = await fetchToken(entry.workerName);
      let proxyToken: string;
      if (lookup.kind === 'found') {
        proxyToken = lookup.token;
      } else if (lookup.kind === 'error') {
        // Transient CF failure. Do NOT silently fall back — that would
        // stamp a potentially wrong token, report the row as `updated`,
        // and permanently mask a control-plane incident as migrated.
        console.error(
          `[backfill-queue-tokens] CF API error reading bindings for "${entry.workerName}": ${lookup.error.message}. Skipping "${name}" — rerun when CF is healthy.`,
        );
        errored++;
        continue;
      } else if (entry.projectId) {
        // lookup.kind === 'missing' — legacy worker, no baked binding.
        // Fall back to re-derivation. Only safe while JWT_SECRET has
        // not rotated since this worker was deployed.
        proxyToken = await hmacSignState(entry.projectId, opts.jwtSecret);
      } else {
        skipped++;
        continue;
      }

      const currentRaw = await routing.get(name);
      if (currentRaw !== snapshotRaw) {
        raced++;
        continue;
      }

      if (opts.dryRun) {
        wouldUpdate++;
        continue;
      }
      await routing.put(name, JSON.stringify({ ...entry, proxyToken }));
      updated++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { scanned, updated, skipped, raced, errored, ...(opts.dryRun ? { wouldUpdate } : {}) };
}
