import type { ApiEnv } from '../env.ts';
import { createAppJwt } from './app-jwt.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION } from './installation-token.ts';

/**
 * App-JWT client for GitHub's webhook delivery-log API. GitHub records every
 * webhook it could not successfully deliver as a `failed` delivery; that log is
 * the authoritative record of events we missed. This module lists those failures
 * (`GET /app/hook/deliveries?status=failure`) and re-sends one
 * (`POST /app/hook/deliveries/{id}/attempts`). Both are BEST-EFFORT and never
 * throw: a scan/redeliver failure must not abort the scheduled reconciliation.
 *
 * Both calls authenticate as the App itself (app JWT — same auth as
 * `getRepoInstallation`), retry only transient 5xx/network failures (mirroring
 * the `getBranchHeadComparisonStatus` / check-run retry shape), do NOT retry
 * definitive 4xx, and log every failure via the shared `area:'github'` warn
 * shape. When the App secrets are unset the module is inert (`[]` / `false`,
 * no fetch), so dev/unconfigured environments stay quiet.
 */

// Same retry shape as compare / check-run: up to 2 extra attempts with a short
// fixed delay on transient 5xx/network. A 4xx is definitive and stops immediately.
const WEBHOOK_DELIVERY_RETRY_ATTEMPTS = 2;
const WEBHOOK_DELIVERY_RETRY_DELAY_MS = 250;

// GitHub caps `per_page` at 100 for this endpoint; use the max so a scan covers
// the most failures per request.
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 5;

export type FailedWebhookDelivery = {
  // String(item.id) — the numeric delivery id, used for the redeliver POST.
  id: string;
  // item.guid — stable across an event's original + all its redeliveries; the
  // dedup key so a permanently-failing event is retried at most once.
  guid: string;
  event: string | null;
  // item.status_code — the failed delivery's HTTP status (audit).
  statusCode: number | null;
  // item.delivered_at (audit).
  deliveredAt: string | null;
};

// A GitHub delivery-log item (only the fields we read).
type DeliveryItem = Readonly<{
  id: number | string;
  guid: string;
  event?: string | null;
  status_code?: number | null;
  delivered_at?: string | null;
}>;

type FailureReason = 'network-error' | 'http-4xx' | 'http-5xx' | 'exhausted' | 'jwt-error';

function errInfo(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

// area:'github' distinguishes from the deploy-pipeline logger (area:'deploy').
// `phase` differentiates the list scan from a redeliver POST.
function logFailure(
  phase: 'webhook-deliveries-list' | 'webhook-redeliver',
  reason: FailureReason,
  fields: Record<string, unknown>,
): void {
  try {
    console.warn(
      JSON.stringify({
        ts: Date.now(),
        lvl: 'warn',
        area: 'github',
        phase,
        reason,
        msg: `${phase} failed: ${reason}`,
        ...fields,
      }),
    );
  } catch {
    console.warn(`${phase} failed: ${reason}`);
  }
}

/**
 * Extract the `rel="next"` URL from a GitHub `Link` response header, or null when
 * there is no next page. The header looks like
 * `<https://api.github.com/...&cursor=X>; rel="next", <...>; rel="last"`; the
 * next URL already carries the opaque `&cursor=…` so we just follow it verbatim.
 */
export function parseNextCursorUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function appJwtHeaders(appJwt: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${appJwt}`,
    'User-Agent': 'void-api',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

// Fetch one deliveries page with 5xx/network retry. Returns the page's items +
// the next-cursor URL on success, or null on a definitive 4xx / exhausted
// transient failures (the caller stops and returns what it has collected).
async function fetchDeliveriesPage(
  url: string,
  appJwt: string,
): Promise<{ items: Array<DeliveryItem>; next: string | null } | null> {
  for (let attempt = 0; attempt <= WEBHOOK_DELIVERY_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: appJwtHeaders(appJwt) });
      if (res.ok) {
        const data = await res.json<unknown>().catch(() => []);
        const items = Array.isArray(data) ? (data as Array<DeliveryItem>) : [];
        return { items, next: parseNextCursorUrl(res.headers.get('Link')) };
      }
      const body = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
      if (res.status < 500) {
        logFailure('webhook-deliveries-list', 'http-4xx', {
          url,
          attempt,
          status: res.status,
          statusText: res.statusText,
          body,
        });
        return null;
      }
      logFailure('webhook-deliveries-list', 'http-5xx', {
        url,
        attempt,
        status: res.status,
        body,
      });
    } catch (err) {
      logFailure('webhook-deliveries-list', 'network-error', { url, attempt, err: errInfo(err) });
    }
    if (attempt < WEBHOOK_DELIVERY_RETRY_ATTEMPTS) {
      await new Promise((r) => {
        setTimeout(r, WEBHOOK_DELIVERY_RETRY_DELAY_MS);
      });
    }
  }
  logFailure('webhook-deliveries-list', 'exhausted', {
    url,
    attempts: WEBHOOK_DELIVERY_RETRY_ATTEMPTS + 1,
  });
  return null;
}

/**
 * List `status=failure` webhook deliveries (newest first), following the
 * `Link` header `rel="next"` cursor up to `maxPages`. Returns `[]` (never throws)
 * when the App secrets are absent, the app-JWT mint fails (malformed key), or the
 * very first page fails; on a mid-scan failure it returns whatever was collected
 * before the failing page.
 */
export async function listFailedWebhookDeliveries(
  env: ApiEnv['Bindings'],
  opts?: { maxPages?: number },
): Promise<Array<FailedWebhookDelivery>> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return [];
  }
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;

  const results: Array<FailedWebhookDelivery> = [];
  // Presence of the secrets != a valid key: importPKCS8 throws on a malformed
  // PEM. Mint inside the guarded region so a bad key is the same never-throws
  // failure as a network error — return what we have (nothing yet).
  let appJwt: string;
  try {
    appJwt = await createAppJwt(env);
  } catch (err) {
    logFailure('webhook-deliveries-list', 'jwt-error', { err: errInfo(err) });
    return results;
  }

  let url: string | null =
    `${GITHUB_API_BASE}/app/hook/deliveries?per_page=${PER_PAGE}&status=failure`;
  for (let page = 0; url && page < maxPages; page++) {
    const pageResult = await fetchDeliveriesPage(url, appJwt);
    if (!pageResult) {
      break;
    }
    for (const item of pageResult.items) {
      results.push({
        id: String(item.id),
        guid: item.guid,
        event: item.event ?? null,
        statusCode: item.status_code ?? null,
        deliveredAt: item.delivered_at ?? null,
      });
    }
    url = pageResult.next;
  }
  return results;
}

/**
 * Re-send a single failed delivery via
 * `POST /app/hook/deliveries/{deliveryId}/attempts`. GitHub answers 202
 * (Accepted) on success. Returns `true` on a 2xx, `false` on a definitive
 * non-2xx / exhausted transient failures / missing secrets / app-JWT mint
 * failure. Best-effort — never throws. Transient 5xx/network is retried; a 4xx
 * is definitive.
 */
export async function redeliverWebhookDelivery(
  env: ApiEnv['Bindings'],
  deliveryId: string,
): Promise<boolean> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return false;
  }
  // Presence of the secrets != a valid key: importPKCS8 throws on a malformed
  // PEM. Mint inside the guarded region so a bad key is the same never-throws
  // failure as a network error.
  let appJwt: string;
  try {
    appJwt = await createAppJwt(env);
  } catch (err) {
    logFailure('webhook-redeliver', 'jwt-error', { deliveryId, err: errInfo(err) });
    return false;
  }
  const url = `${GITHUB_API_BASE}/app/hook/deliveries/${encodeURIComponent(deliveryId)}/attempts`;

  for (let attempt = 0; attempt <= WEBHOOK_DELIVERY_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: appJwtHeaders(appJwt) });
      if (res.ok) {
        return true;
      }
      const body = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
      if (res.status < 500) {
        logFailure('webhook-redeliver', 'http-4xx', {
          deliveryId,
          attempt,
          status: res.status,
          statusText: res.statusText,
          body,
        });
        return false;
      }
      logFailure('webhook-redeliver', 'http-5xx', {
        deliveryId,
        attempt,
        status: res.status,
        body,
      });
    } catch (err) {
      logFailure('webhook-redeliver', 'network-error', { deliveryId, attempt, err: errInfo(err) });
    }
    if (attempt < WEBHOOK_DELIVERY_RETRY_ATTEMPTS) {
      await new Promise((r) => {
        setTimeout(r, WEBHOOK_DELIVERY_RETRY_DELAY_MS);
      });
    }
  }
  logFailure('webhook-redeliver', 'exhausted', {
    deliveryId,
    attempts: WEBHOOK_DELIVERY_RETRY_ATTEMPTS + 1,
  });
  return false;
}
