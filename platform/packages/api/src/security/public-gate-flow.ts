/**
 * The public gate's drivers (design doc 0095 M16, spec §5.5): the code that runs the
 * flip re-check, the bypass and the hourly backstop through the Zero Trust checkpoint
 * (`zero-trust/project.ts`), which holds the project and Zero Trust locks. The
 * transaction-level pieces are in `public-gate.ts`.
 *
 *   re-check triggers                      what runs
 *   request, ingest, resolve / reopen,     reconcileProjectZeroTrustGated (gate: flip)
 *   cutover, rollback, bypass, hourly        judge ─ hold: stays protected, state saved
 *                                                  └ pass: desired_protected = false and
 *                                                    the request closes, one transaction;
 *                                                    then the normal reconcile
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { ZeroTrustConfigurationError } from '../zero-trust/configuration.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { reconcileProjectZeroTrustGated } from '../zero-trust/project.ts';
import type { GatedReconciliation } from '../zero-trust/project.ts';
import { MAX_ROUTING_KEYS_PER_RUN } from '../zero-trust/routing.ts';
import type { RoutingBudget } from '../zero-trust/routing.ts';
import { pokeSecurityScanScheduler } from './enqueue.ts';
import { SecurityApiError } from './errors.ts';
import { parseBypassReason, readOpenPublicRequest } from './public-gate.ts';
import type { GateActor, PublicRequestRow } from './public-gate.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  securityPublicRequests,
  securityScans,
} from './schema.ts';

function capabilityOn(env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>): boolean {
  try {
    return getPlatformCapabilities(env).securityAudits;
  } catch {
    return false;
  }
}

/**
 * Judges the project's open request again and, on a pass, goes public. `null` when no
 * request is open (or the capability is off). A Zero Trust installation that is busy or
 * misconfigured leaves the request where the judge put it; the hourly backstop retries.
 */
export async function recheckPublicRequest(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options: Readonly<{ routingBudget?: RoutingBudget }> = {},
): Promise<PublicRequestRow | null> {
  if (!capabilityOn(env)) {
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

/**
 * The re-check after a state change (ingest, resolve, cutover, rollback): never throws.
 * Returns the request as it is now (open, or just closed), or `null`.
 */
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
      error: error instanceof Error ? error.message : String(error),
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
  if (!capabilityOn(env)) {
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
  /**
   * The open request the caller saw. Under the lock, a request closed meanwhile (a
   * protect, a pass, another bypass) is a 409 `public request closed` with its state.
   */
  requestId?: string | null;
  reason: unknown;
  actor: GateActor & { kind: 'user' | 'installation_admin'; userId: string };
}>;

/**
 * Bypass the gate scan of the open request (spec §5.5). The checks run under the lock
 * the flip re-check holds: the request is still open, installation Zero Trust and the
 * project row are ready, and no urgent finding is open. Refusals record nothing.
 */
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
 * Hourly backstop (spec §5.5): judge every open request again, for example after an
 * installation operation ends. Holds need no routing budget, so every picked request is
 * judged. A pass that finds the run's remaining routing budget too small commits its
 * checkpoint and leaves the project reconciling for the next batch (the checkpoint's
 * own rule). Each judged request moves to the back of the line (`updated_at`), so
 * a held request does not keep the same twenty in front of the others.
 */
export async function reconcilePendingPublicRequests(
  env: ApiEnv['Bindings'],
  db: Db,
  limit = 20,
  /** The cron run's remaining routing budget (shared with the project reconcile). */
  routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN },
): Promise<number> {
  if (!capabilityOn(env)) {
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
        error: error instanceof Error ? error.message : String(error),
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
