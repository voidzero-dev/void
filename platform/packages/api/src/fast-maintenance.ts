/**
 * The two-minute cron only works while this marker is present in routing KV.
 * An idle tick reads the marker and returns before it opens a database
 * connection, so an idle installation lets its PostgreSQL compute suspend.
 *
 * Whatever can create fast-tier work arms the marker: a mutating API request,
 * a deployment Queue delivery, and a scheduled tick that found work it has
 * not finished. The hourly cron runs every step regardless and is the
 * backstop for a marker write that failed.
 */
export const FAST_MAINTENANCE_KEY = '__void/platform/fast-maintenance/v1';

// Longer than the deployment execution lease, so the outbox still runs when
// an abandoned deployment becomes claimable.
const ARMED_SECONDS = 30 * 60;
// A marker armed more recently than this is left alone, to bound KV writes.
const REFRESH_MS = 5 * 60 * 1000;

type FastMaintenanceEnv = Readonly<{ ROUTING: KVNamespace }>;

/** When the marker was last armed, or null when the fast tier is idle. */
export async function fastMaintenanceArmedAt(env: FastMaintenanceEnv): Promise<string | null> {
  return env.ROUTING.get(FAST_MAINTENANCE_KEY);
}

/** Pass `armedAt` when the caller has already read the marker. */
export async function armFastMaintenance(
  env: FastMaintenanceEnv,
  armedAt?: string | null,
): Promise<void> {
  try {
    const current = armedAt === undefined ? await fastMaintenanceArmedAt(env) : armedAt;
    const now = Date.now();
    // An unreadable timestamp compares false and is rewritten.
    if (current !== null && now - Date.parse(current) < REFRESH_MS) {
      return;
    }
    await env.ROUTING.put(FAST_MAINTENANCE_KEY, new Date(now).toISOString(), {
      expirationTtl: ARMED_SECONDS,
    });
  } catch (error) {
    console.error('[fast-maintenance] failed to arm the two-minute tier:', error);
  }
}
