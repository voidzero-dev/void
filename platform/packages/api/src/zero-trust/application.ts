import { readPlatformApplication } from '@void/platform';
import type { PlatformApplication } from '@void/platform';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformSetting } from '../platform-settings.ts';
import {
  parseZeroTrustApplicationTarget,
  readZeroTrustConfigurationStrict,
  ZeroTrustConfigurationError,
} from './configuration.ts';
import type { ZeroTrustConfiguration } from './configuration.ts';

export const PLATFORM_APPLICATION_SETTING = 'platform.application';

export function applicationTargetEnvironment(
  env: ApiEnv['Bindings'],
  target: PlatformApplication,
): ApiEnv['Bindings'] {
  const current = readPlatformApplication(env);
  if (
    !current.workersDev ||
    !target.workersDev ||
    current.workersDev.installationId !== target.workersDev.installationId ||
    current.workersDev.subdomain !== target.workersDev.subdomain ||
    target.workersDev.installationId !== env.PLATFORM_INSTALLATION_ID ||
    (current.zoneName && current.baseDomain !== target.baseDomain)
  ) {
    throw new ZeroTrustConfigurationError('Application target does not match this installation.');
  }
  return {
    ...env,
    PLATFORM_APPLICATION: JSON.stringify(target),
    SITE_DOMAIN: target.baseDomain,
    CF_ZONE_ID: target.zoneId!,
  };
}

/** Durable targets take precedence over Worker vars and eventually consistent KV reads. */
export async function resolveZeroTrustApplicationEnvironment(
  env: ApiEnv['Bindings'],
  db: DbOrTx,
  configuration?: ZeroTrustConfiguration | null,
): Promise<ApiEnv['Bindings']> {
  const saved =
    configuration === undefined ? await readZeroTrustConfigurationStrict(db) : configuration;
  const value =
    saved?.operation?.applicationTarget ??
    (await getPlatformSetting(db, PLATFORM_APPLICATION_SETTING));
  return value === null
    ? env
    : applicationTargetEnvironment(env, parseZeroTrustApplicationTarget(value));
}
