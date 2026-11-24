/**
 * Gateway cost of ended scans (spec §16, PRD §10.6): what AI Gateway says each scan cost,
 * next to the metered spend, so the Scans screen can check the meter. The caps never use
 * it: gateway cost data arrives late.
 *
 *   hourly job ─► ended scans, finished 1 h – 7 d ago, cost unknown (25 a run)
 *                   no model call ──► cost 0, no query
 *                   else ──► GraphQL `aiGatewayRequestsAdaptiveGroups`, filtered on the
 *                            scan's signed `securityScan` tag, `sum { cost }`
 *                 a failed query stops the run; the rows stay unknown and are tried again
 *
 * The tag is signed under JWT_SECRET (`deriveSecurityScanTag`), the same rule as project
 * AI usage: anyone who knows the gateway URL can write log rows, never a valid tag.
 */
import { and, asc, eq, gte, isNull, lte, notInArray } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { aiUsageGraphqlErrors } from '../routes/usage.ts';
import { NANO_USD_PER_USD } from './budget.ts';
import { securityScans } from './schema.ts';

/** Gateway analytics arrive late; a scan is asked about this long after it ended. */
export const SECURITY_GATEWAY_COST_DELAY_MS = 60 * 60_000;
/** After this long a cost that is still unknown stays unknown. */
export const SECURITY_GATEWAY_COST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Scans one hourly run asks about, at most. */
export const SECURITY_GATEWAY_COST_BATCH = 25;
/** Slack on each side of the scan's time window (clock skew, late log rows). */
const WINDOW_SLACK_MS = 10 * 60_000;

/** The gateway cost in USD of every call carrying `tag` between `since` and `until`. */
export type SecurityGatewayCostQuery = (tag: string, since: Date, until: Date) => Promise<number>;

export type SecurityGatewayCostDeps = Readonly<{
  query: SecurityGatewayCostQuery;
  scanTag(scanId: string): Promise<string>;
}>;

type CostResponse = Readonly<{
  data?: {
    viewer?: {
      accounts?: ReadonlyArray<{
        requests?: ReadonlyArray<{ sum?: { cost?: number | null } }> | null;
      }> | null;
    } | null;
  } | null;
  errors?: unknown;
}>;

/** One strict GraphQL query: any error throws, so a bad answer is never stored as a cost. */
export async function queryAiGatewayTagCost(
  input: Readonly<{ accountId: string; apiToken: string; gatewayId: string }>,
  tag: string,
  since: Date,
  until: Date,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const query = `query {
  viewer {
    accounts(filter: { accountTag: ${JSON.stringify(input.accountId)} }) {
      requests: aiGatewayRequestsAdaptiveGroups(
        limit: 1
        filter: {
          gateway: ${JSON.stringify(input.gatewayId)}
          metadataRaw: ${JSON.stringify(JSON.stringify({ securityScan: tag }))}
          datetime_geq: "${since.toISOString()}"
          datetime_lt: "${until.toISOString()}"
        }
      ) {
        sum { cost }
      }
    }
  }
}`;
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`AI Gateway cost query failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as CostResponse | null;
  if (result?.errors !== undefined && result.errors !== null) {
    if (!Array.isArray(result.errors)) {
      throw new Error('AI Gateway cost query returned invalid GraphQL errors');
    }
    if (result.errors.length > 0) {
      throw new Error(
        `AI Gateway cost query failed: ${aiUsageGraphqlErrors(result.errors, input.apiToken)}`,
      );
    }
  }
  const accounts = result?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error('AI Gateway cost query returned no account data');
  }
  const requests = accounts[0]?.requests;
  if (!Array.isArray(requests) || requests.length > 1) {
    throw new Error('AI Gateway cost query returned invalid request data');
  }
  if (requests.length === 0) {
    return 0;
  }
  const cost = requests[0]?.sum?.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new Error('AI Gateway cost query returned invalid cost data');
  }
  return cost;
}

function stamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Fills `cost_nano_usd` of ended scans whose gateway cost is due. Returns how many. */
export async function fillSecurityGatewayCosts(
  db: Db,
  deps: SecurityGatewayCostDeps,
  now: number,
): Promise<number> {
  const rows = await db
    .select({
      id: securityScans.id,
      modelCalls: securityScans.model_calls,
      startedAt: securityScans.started_at,
      queuedAt: securityScans.first_queued_at,
      createdAt: securityScans.created_at,
      finishedAt: securityScans.finished_at,
    })
    .from(securityScans)
    .where(
      and(
        isNull(securityScans.cost_nano_usd),
        notInArray(securityScans.status, ['pending_input', 'queued', 'running']),
        lte(
          securityScans.finished_at,
          new Date(now - SECURITY_GATEWAY_COST_DELAY_MS).toISOString(),
        ),
        gte(
          securityScans.finished_at,
          new Date(now - SECURITY_GATEWAY_COST_MAX_AGE_MS).toISOString(),
        ),
      ),
    )
    .orderBy(asc(securityScans.finished_at), asc(securityScans.id))
    .limit(SECURITY_GATEWAY_COST_BATCH);
  let filled = 0;
  for (const row of rows) {
    let nano = 0;
    if (row.modelCalls > 0) {
      const finished = stamp(row.finishedAt)!;
      // The first queue time: a retried attempt keeps the calls of the earlier one.
      const from = stamp(row.queuedAt) ?? stamp(row.startedAt) ?? stamp(row.createdAt) ?? finished;
      const usd = await deps.query(
        await deps.scanTag(row.id),
        new Date(from - WINDOW_SLACK_MS),
        new Date(finished + WINDOW_SLACK_MS),
      );
      nano = Math.round(usd * NANO_USD_PER_USD);
    }
    const updated = await db
      .update(securityScans)
      .set({ cost_nano_usd: nano })
      .where(and(eq(securityScans.id, row.id), isNull(securityScans.cost_nano_usd)))
      .returning({ id: securityScans.id });
    filled += updated.length;
  }
  return filled;
}
