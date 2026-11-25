/**
 * The public gate's drivers (M16, spec §5.5): the flip re-check, the bypass and the hourly
 * backstop, run through the Zero Trust checkpoint (`zero-trust/project.ts`), which holds
 * the project and Zero Trust locks. Transaction pieces are in `public-gate.ts`.
 *
 *   request, ingest, resolve, cutover, rollback, bypass, hourly
 *     ─► judge ─ hold: stays protected │ pass: desired_protected = false, request closes
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { ZeroTrustConfigurationError } from '../zero-trust/configuration.ts';
import { errorMessage, ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { reconcileProjectZeroTrustGated } from '../zero-trust/project.ts';
import type { GatedReconciliation } from '../zero-trust/project.ts';
import { MAX_ROUTING_KEYS_PER_RUN } from '../zero-trust/routing.ts';
import type { RoutingBudget } from '../zero-trust/routing.ts';
import { pokeSecurityScanScheduler, securityAuditsOn } from './enqueue.ts';
import { SecurityApiError } from './errors.ts';
import { securityWorkPaused } from './paused.ts';
import { parseBypassReason, readOpenPublicRequest } from './public-gate.ts';
import type { GateActor, PublicRequestRow } from './public-gate.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  securityPublicRequests,
  securityScans,
} from './schema.ts';

/**
 * Judges the open request again and, on a pass, goes public; `null` when none is open. A
 * busy or misconfigured Zero Trust installation leaves it for the hourly backstop.
 */
export async function recheckPublicRequest(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options: Readonly<{ routingBudget?: RoutingBudget }> = {},
): Promise<PublicRequestRow | null> {
  if (!securityAuditsOn(env)) {
    return null;
  }
  const open = await readOpenPublicRequest(db, projectId);
  if (!open) {
    return null;
  }
  try {
    const result = await reconcileProjectZeroTrustGated(env, db, projectId, {
      desiredProtection: false,
      routingBudget: options.routingBudget,
      gate: { kind: 'flip', requestId: open.id },
    });
    return result.publicRequest;
  } catch (error) {
    if (
      error instanceof ZeroTrustUnavailableError ||
      error instanceof ZeroTrustConfigurationError
    ) {
      return open;
    }
    throw error;
  }
}

/** The re-check after a state change: never throws; the request as it is now, or `null`. */
export async function recheckPublicRequestBestEffort(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  what: string,
): Promise<PublicRequestRow | null> {
  try {
    return await recheckPublicRequest(env, db, projectId);
  } catch (error) {
    console.error(`[security-gate] re-check after ${what} failed`, {
      projectId,
      error: errorMessage(error),
    });
    return null;
  }
}

/** After a scan ends (ingest, skip, timeout, cancel): re-check the project of that scan. */
export async function recheckPublicRequestForScan(
  env: ApiEnv['Bindings'],
  db: Db,
  scanId: string,
): Promise<void> {
  // While the platform is disabled, a request stays open with no Access change.
  if (!securityAuditsOn(env) || (await securityWorkPaused(env))) {
    return;
  }
  const [scan] = await db
    .select({ projectId: securityScans.project_id })
    .from(securityScans)
    .where(eq(securityScans.id, scanId))
    .limit(1);
  if (scan) {
    await recheckPublicRequestBestEffort(env, db, scan.projectId, 'a scan ended');
  }
}

export type BypassInput = Readonly<{
  projectId: string;
  /** The open request the caller saw; closed meanwhile is a 409 under the lock. */
  requestId?: string | null;
  reason: unknown;
  actor: GateActor & { kind: 'user' | 'installation_admin'; userId: string };
}>;

/** Bypass the open request's gate scan (§5.5), checked under the flip lock; refusals record nothing. */
export async function bypassPublicRequest(
  env: ApiEnv['Bindings'],
  db: Db,
  input: BypassInput,
): Promise<GatedReconciliation> {
  const reason = parseBypassReason(input.reason);
  let requestId = input.requestId ?? null;
  if (requestId === null) {
    const open = await readOpenPublicRequest(db, input.projectId);
    if (!open) {
      throw SecurityApiError.of(
        'noPublicRequest',
        'This project has no public request to bypass. Run: void project zero-trust public',
      );
    }
    requestId = open.id;
  }
  return reconcileProjectZeroTrustGated(env, db, input.projectId, {
    desiredProtection: false,
    // A project member is authorized again under the lock; an installation admin is not.
    ...(input.actor.kind === 'user' ? { actorUserId: input.actor.userId } : {}),
    gate: { kind: 'bypass', requestId, reason, actor: input.actor },
  });
}

/**
 * Hourly backstop (§5.5): judge open requests again, oldest `updated_at` first; each one
 * judged moves to the back of the line, so held requests do not block the others.
 */
export async function reconcilePendingPublicRequests(
  env: ApiEnv['Bindings'],
  db: Db,
  limit = 20,
  routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN },
): Promise<number> {
  if (!securityAuditsOn(env)) {
    return 0;
  }
  const rows = await db
    .select({ id: securityPublicRequests.id, projectId: securityPublicRequests.project_id })
    .from(securityPublicRequests)
    .where(inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]))
    .orderBy(securityPublicRequests.updated_at, securityPublicRequests.id)
    .limit(limit);
  let judged = 0;
  for (const row of rows) {
    try {
      await recheckPublicRequest(env, db, row.projectId, { routingBudget });
      judged++;
    } catch (error) {
      console.error('[security-gate] hourly re-check failed', {
        projectId: row.projectId,
        error: errorMessage(error),
      });
    }
    // Rotate: a hold that changed nothing did not touch the row.
    await db
      .update(securityPublicRequests)
      .set({ updated_at: sql`now()` })
      .where(
        and(
          eq(securityPublicRequests.id, row.id),
          inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
        ),
      )
      .catch(() => undefined);
  }
  if (judged > 0) {
    await pokeSecurityScanScheduler(env);
  }
  return judged;
}
