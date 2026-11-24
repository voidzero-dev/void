import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
import type { ApiEnv } from '../env.ts';

/**
 * The same stop as the cron (`index.ts`): a disabled or staged platform starts no
 * scan and changes no Access. Queued work and open public requests wait until it is
 * enabled; the hourly re-check judges them then.
 */
export async function securityWorkPaused(env: ApiEnv['Bindings']): Promise<boolean> {
  return (
    env.PLATFORM_TRAFFIC_STATE === 'staging' ||
    env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
    (Boolean(env.PLATFORM_INSTALLATION_ID) &&
      (await env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE)
  );
}
