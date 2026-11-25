import { platformHealthHostname, readPlatformApplication } from '@void/platform';
import { sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectZeroTrust } from '../schema.ts';
import { resolveZeroTrustApplicationEnvironment } from './application.ts';
import { publicAppManagementApplication, reusablePolicyReferences } from './cloudflare.ts';
import {
  ZeroTrustConfigurationError,
  readZeroTrustConfigurationStrict,
  redactedZeroTrustConfiguration,
  zeroTrustWildcardDestinations,
} from './configuration.ts';
import type { ZeroTrustConfiguration } from './configuration.ts';
import { clientForConfiguration, projectZeroTrustState } from './state.ts';

/**
 * Installation status from saved state. `check` also asks Cloudflare whether
 * the account, selections, wildcard application, and platform health exception
 * still match; it makes several Access API calls, so reads leave it off unless
 * an operator asks.
 */
export async function zeroTrustStatus(
  env: ApiEnv['Bindings'],
  db: Db,
  options: Readonly<{ check?: boolean }> = {},
) {
  const groups = await db
    .select({
      desiredProtected: projectZeroTrust.desired_protected,
      effectiveProtected: projectZeroTrust.effective_protected,
      status: projectZeroTrust.status,
      count: sql<number>`count(*)::int`,
    })
    .from(projectZeroTrust)
    .groupBy(
      projectZeroTrust.desired_protected,
      projectZeroTrust.effective_protected,
      projectZeroTrust.status,
    );
  const projectCounts = groups.map(({ desiredProtected, effectiveProtected, status, count }) => ({
    desiredProtected,
    effectiveProtected,
    state: projectZeroTrustState({ status, desired_protected: desiredProtected }),
    count,
  }));
  let configuration: ZeroTrustConfiguration | null;
  try {
    configuration = await readZeroTrustConfigurationStrict(db);
  } catch (error) {
    if (!(error instanceof ZeroTrustConfigurationError)) {
      throw error;
    }
    return {
      configured: true,
      enabled: false,
      status: 'invalid_configuration' as const,
      lastError: error.message,
      checked: false,
      live: null,
      projects: projectCounts,
    };
  }
  const checked =
    !!options.check && !!configuration?.enabled && !!configuration.wildcardApplication;
  let live: { present: boolean; drifted: boolean } | null = null;
  if (checked && configuration?.wildcardApplication) {
    try {
      env = await resolveZeroTrustApplicationEnvironment(env, db, configuration);
      const client = await clientForConfiguration(env, configuration);
      const selection = configuration.publicAccess
        ? await client.getOrganization()
        : await client.validateSelection({
            identityProviderIds: configuration.identityProviderIds,
            policyIds: configuration.policyIds,
          });
      const guardDestination = configuration.publicAccessGuardDestination;
      if (configuration.publicAccess && !guardDestination) {
        throw new ZeroTrustConfigurationError('Public app management destination is missing.');
      }
      live = await client.inspectApplication(
        configuration.wildcardApplication,
        configuration.publicAccess && guardDestination
          ? publicAppManagementApplication(configuration.wildcardApplicationName, guardDestination)
          : {
              name: configuration.wildcardApplicationName,
              destinations: zeroTrustWildcardDestinations(readPlatformApplication(env)),
              allowedIdentityProviderIds: configuration.identityProviderIds,
              policies: reusablePolicyReferences(configuration.policyIds),
            },
      );
      const healthHostname = platformHealthHostname(readPlatformApplication(env));
      if (healthHostname) {
        // A missing health exception sends platform health probes to Access;
        // one that covers more than `/health` leaves project paths outside it.
        const health = configuration.healthApplication
          ? await client.inspectHealthApplication(
              configuration.healthApplication,
              configuration.healthApplicationName,
              healthHostname,
            )
          : { present: false, drifted: true };
        live = {
          present: live.present && health.present,
          drifted: live.drifted || health.drifted,
        };
      }
      if (selection.teamDomain !== configuration.teamDomain) {
        live = { ...live, drifted: true };
      }
    } catch (error) {
      live = { present: false, drifted: true };
      console.error('[zero-trust] live status check failed', error);
    }
  }
  return {
    ...redactedZeroTrustConfiguration(configuration),
    checked,
    live,
    projects: projectCounts,
  };
}
