import { getRedeliveredGuids, recordWebhookRedelivery } from './db.ts';
import type { Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import {
  listFailedWebhookDeliveries,
  redeliverWebhookDelivery,
} from './github/webhook-deliveries.ts';

// Per-run attempt cap: at most this many distinct failed deliveries are
// redelivered on one scheduled pass, so a large backlog is drained gradually
// without hammering GitHub's redeliver API from a single tick.
export const MAX_WEBHOOK_REDELIVERIES_PER_RUN = 50;

// Cap on the number of `status=failure` delivery-log pages the scan follows.
export const MAX_WEBHOOK_DELIVERY_PAGES = 5;

/**
 * Catch-up job for missed GitHub webhooks (design-doc 0074, layer 1). Lists
 * GitHub's `status=failure` deliveries, redelivers each one whose `guid` we have
 * not already redelivered (deduped both against the ledger and within the batch),
 * and records each success. A redelivered event re-enters `POST /webhooks/github`
 * and is absorbed by the existing idempotent handlers, so replay is safe with no
 * change to the webhook handler.
 *
 * App-secret gated (no-op when the App is unconfigured) and best-effort: it never
 * throws — each redelivery is independently caught, so one failure never aborts
 * the rest of the run.
 */
export async function replayFailedWebhookDeliveries(
  env: ApiEnv['Bindings'],
  db: Db,
  opts?: { maxRedeliveries?: number; maxPages?: number },
): Promise<{ scanned: number; redelivered: number }> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return { scanned: 0, redelivered: 0 };
  }

  const maxRedeliveries = opts?.maxRedeliveries ?? MAX_WEBHOOK_REDELIVERIES_PER_RUN;
  const maxPages = opts?.maxPages ?? MAX_WEBHOOK_DELIVERY_PAGES;

  const failed = await listFailedWebhookDeliveries(env, { maxPages });
  const seen = await getRedeliveredGuids(
    db,
    failed.map((d) => d.guid),
  );

  // In-batch dedup: GitHub returns the original delivery AND each of its prior
  // redeliveries, all sharing one guid — attempt each guid at most once per run.
  const attempted = new Set<string>();
  let redelivered = 0;

  for (const d of failed) {
    // The cap bounds distinct ATTEMPTS (not the scan): stop once we've attempted
    // maxRedeliveries unique guids this run; the rest drain on the next tick.
    if (attempted.size >= maxRedeliveries) {
      break;
    }
    if (seen.has(d.guid) || attempted.has(d.guid)) {
      continue;
    }
    attempted.add(d.guid);
    try {
      const ok = await redeliverWebhookDelivery(env, d.id);
      if (ok) {
        await recordWebhookRedelivery(db, {
          guid: d.guid,
          deliveryId: d.id,
          event: d.event,
          statusCode: d.statusCode,
        });
        redelivered++;
      }
    } catch (err) {
      console.warn('[webhook-replay] redeliver failed for guid', d.guid, err);
    }
  }

  return { scanned: failed.length, redelivered };
}
