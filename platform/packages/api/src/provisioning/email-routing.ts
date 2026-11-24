/**
 * Cloudflare Email Routing destination-address API client.
 *
 * Destinations are CF account-level — adding `user@example.com` here makes
 * it available to the account's email senders. Per-project consent is enforced
 * by the platform's SQL admission transaction.
 *
 * `addDestination` triggers CF to email the recipient with a verification
 * link. Status flips from `pending` → `verified` once they click. We poll
 * via `listDestinations` on read to surface
 * fresh status to the caller.
 */

import { cfFetch, CF_API_BASE, CloudflareApiError } from './cloudflare-api.ts';

// CF Email Routing returns "destination address X already exists" or
// similar wording when re-registering an account-level address. Keep a text
// fallback for provider variants that omit the documented numeric code.
const ALREADY_EXISTS_PATTERN = /already exists|destination already/i;

export interface CfDestinationAddress {
  /** CF's account-scoped UUID for the destination. */
  tag: string;
  email: string;
  /** RFC 3339 timestamp; non-null means the recipient clicked the link. */
  verified: string | null;
  created: string;
  modified: string;
}

const ROUTING_BASE = (accountId: string) => `${CF_API_BASE}/${accountId}/email/routing/addresses`;

/**
 * Add a destination address to the platform CF account. CF responds
 * immediately with the row; the recipient gets a verification email and
 * `verified` stays null until they click the link.
 */
export async function addDestination(
  accountId: string,
  apiToken: string,
  email: string,
): Promise<CfDestinationAddress> {
  return cfFetch<CfDestinationAddress>(ROUTING_BASE(accountId), apiToken, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

const LIST_PAGE_SIZE = 50;
const LIST_PAGE_CAP = 1000;
const LIST_PAGE_WARN = 500;

/**
 * List all destinations on the account. Used for bulk status sync — the
 * /destinations API on the platform calls this and updates row statuses
 * for any pending rows whose CF counterpart is now verified.
 *
 * Paginates through every page so callers see the full account-level
 * list. Without pagination, status-refresh and "already exists" recovery
 * would silently miss rows once the platform account exceeds page 1.
 */
export async function listDestinations(
  accountId: string,
  apiToken: string,
): Promise<Array<CfDestinationAddress>> {
  const out: Array<CfDestinationAddress> = [];
  for (let page = 1; page <= LIST_PAGE_CAP; page++) {
    if (page === LIST_PAGE_WARN) {
      console.warn(
        `[email-routing] listDestinations has fetched ${LIST_PAGE_WARN} pages — account is approaching the ${LIST_PAGE_CAP}-page hard cap`,
      );
    }
    const url = `${ROUTING_BASE(accountId)}?page=${page}&per_page=${LIST_PAGE_SIZE}`;
    const batch = await cfFetch<Array<CfDestinationAddress>>(url, apiToken);
    out.push(...batch);
    if (batch.length < LIST_PAGE_SIZE) {
      return out;
    }
  }
  // Hit the safety cap — surface so the operator notices instead of
  // silently truncating recovery/refresh against a huge account.
  throw new Error(`listDestinations exceeded ${LIST_PAGE_CAP} pages — increase cap or paginate`);
}

/** Delete an account-level destination after durable cleanup has fenced new references. */
export async function deleteDestination(
  accountId: string,
  apiToken: string,
  destinationTag: string,
): Promise<{ tag: string }> {
  return cfFetch<{ tag: string }>(`${ROUTING_BASE(accountId)}/${destinationTag}`, apiToken, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * True when a CF Email Routing error means the address was already on the
 * account — the only error we treat as recoverable. Auth/network/transient
 * failures must surface, not swallow.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err instanceof CloudflareApiError && err.codes.includes(10_037)) {
    return true;
  }
  return ALREADY_EXISTS_PATTERN.test(err.message);
}
