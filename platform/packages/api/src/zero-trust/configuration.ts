import type { PlatformApplication } from '@void/platform';
import { platformProjectIngressPrefix, readPlatformApplication } from '@void/platform';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import type { EncryptedPlatformCredential } from '../project-secrets.ts';
import { platformSettings } from '../schema.ts';
import { publicAppManagementDestination } from './cloudflare.ts';

const ZERO_TRUST_SETTING = 'zeroTrust.configuration';
export const ZERO_TRUST_CREDENTIAL_ID = 'zero-trust-cloudflare-api-token';

export type ManagedAccessApplication = Readonly<{
  id: string;
  name: string;
  audience: string;
  destinations: ReadonlyArray<string>;
}>;

export type ZeroTrustOperation = Readonly<{
  /** Stable across retries; separates completion even when database clocks coincide. */
  id: string;
  kind: 'configure' | 'reconcile' | 'disable';
  phase: 'seed' | 'public-bypasses' | 'wildcard' | 'projects' | 'wildcard-delete' | 'bypass-delete';
  owner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string;
  existingProjects: 'protected' | 'public' | null;
  /** Installer-verified domain addition, retained across bounded reconciliation runs. */
  applicationTarget?: PlatformApplication;
}>;

export type ZeroTrustConfiguration = Readonly<{
  publicAccess?: true;
  /** Public-only setups reserve a dispatch check path; the shared application never bypasses a wildcard. */
  publicAccessGuardDestination?: string;
  managePublicCustomDomains?: true;
  version: 1;
  /** Compare-and-swap token; every write increments it. */
  revision: number;
  enabled: boolean;
  protectNewProjects: boolean;
  accountId: string;
  teamDomain: string;
  identityProviderIds: ReadonlyArray<string>;
  policyIds: ReadonlyArray<string>;
  credential: EncryptedPlatformCredential;
  /** Committed before the wildcard application is created, so a retry can recover it. */
  wildcardApplicationName: string;
  wildcardApplication: ManagedAccessApplication | null;
  /**
   * Exact-host bypass for the platform health hostname, so health probes reach
   * dispatch through the wildcard. Its name is committed before it is created.
   */
  healthApplicationName: string | null;
  /** A name different from healthApplicationName is an external reference, never ours to mutate. */
  healthApplication: ManagedAccessApplication | null;
  operation: ZeroTrustOperation | null;
  lastError: string | null;
  updatedAt: string;
}>;

export type ZeroTrustStatus = 'configuring' | 'ready' | 'disabling' | 'error';

/** The installation status follows from the saved operation and its last failure. */
export function zeroTrustConfigurationStatus(
  configuration: ZeroTrustConfiguration,
): ZeroTrustStatus {
  if (configuration.lastError !== null) {
    return 'error';
  }
  if (!configuration.operation) {
    return 'ready';
  }
  return configuration.operation.kind === 'disable' ? 'disabling' : 'configuring';
}

export type ZeroTrustConfigureInput = Readonly<{
  /** Installer-only public rules for accounts with Default-Deny. */
  publicAccess?: true;
  managePublicCustomDomains?: true;
  apiToken: string;
  identityProviderIds: ReadonlyArray<string>;
  policyIds: ReadonlyArray<string>;
  protectNewProjects: boolean;
  /** Required when enabling from disabled; rejected otherwise. */
  existingProjects?: 'protected' | 'public';
}>;

export class ZeroTrustConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroTrustConfigurationError';
  }
}

/**
 * The configuration saved in PostgreSQL cannot be read. This is a server
 * state problem, not a bad request; only a database repair can clear it.
 */
export class ZeroTrustSavedConfigurationError extends ZeroTrustConfigurationError {
  constructor(detail: string) {
    super(
      `The saved Zero Trust configuration is invalid (${detail}). Zero Trust changes are blocked until the \`${ZERO_TRUST_SETTING}\` platform setting is repaired or restored from a database backup.`,
    );
    this.name = 'ZeroTrustSavedConfigurationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ZeroTrustConfigurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new ZeroTrustConfigurationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const result = requiredText(value, label, 128);
  if (!Number.isFinite(Date.parse(result))) {
    throw new ZeroTrustConfigurationError(`${label} is invalid`);
  }
  return result;
}

function ids(value: unknown, label: string, minimum = 1): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length < minimum || value.length > 16) {
    throw new ZeroTrustConfigurationError(`${label} must contain between 1 and 16 ids`);
  }
  const result = value.map((entry) => requiredText(entry, `${label} id`, 128));
  if (new Set(result).size !== result.length) {
    throw new ZeroTrustConfigurationError(`${label} must not contain duplicate ids`);
  }
  return result;
}

function parseCredential(value: unknown): EncryptedPlatformCredential {
  const input = record(value, 'encrypted Zero Trust credential');
  return {
    ciphertext: requiredText(input.ciphertext, 'credential ciphertext', 32 * 1024),
    iv: requiredText(input.iv, 'credential IV', 256),
    keyVersion: requiredText(input.keyVersion, 'credential key version', 128),
  };
}

function parseApplication(value: unknown): ManagedAccessApplication | null {
  if (value === null) {
    return null;
  }
  const input = record(value, 'managed Access application');
  if (!Array.isArray(input.destinations) || input.destinations.length < 1) {
    throw new ZeroTrustConfigurationError('managed Access application needs destinations');
  }
  return {
    id: requiredText(input.id, 'managed application id', 128),
    name: requiredText(input.name, 'managed application name', 128),
    audience: requiredText(input.audience, 'managed application audience', 512),
    destinations: input.destinations.map((destination) =>
      requiredText(destination, 'managed application destination', 512),
    ),
  };
}

function parseOperation(value: unknown): ZeroTrustOperation | null {
  if (value === null || value === undefined) {
    return null;
  }
  const input = record(value, 'Zero Trust operation');
  if (!['configure', 'reconcile', 'disable'].includes(String(input.kind))) {
    throw new ZeroTrustConfigurationError('Zero Trust operation kind is invalid');
  }
  if (
    ![
      'seed',
      'public-bypasses',
      'wildcard',
      'projects',
      'wildcard-delete',
      'bypass-delete',
    ].includes(String(input.phase))
  ) {
    throw new ZeroTrustConfigurationError('Zero Trust operation phase is invalid');
  }
  if (input.owner !== null && typeof input.owner !== 'string') {
    throw new ZeroTrustConfigurationError('Zero Trust operation owner is invalid');
  }
  if (input.leaseExpiresAt !== null && typeof input.leaseExpiresAt !== 'string') {
    throw new ZeroTrustConfigurationError('Zero Trust operation lease is invalid');
  }
  if ((input.owner === null) !== (input.leaseExpiresAt === null)) {
    throw new ZeroTrustConfigurationError('Zero Trust operation ownership is invalid');
  }
  if (
    input.existingProjects !== null &&
    input.existingProjects !== 'protected' &&
    input.existingProjects !== 'public'
  ) {
    throw new ZeroTrustConfigurationError('Zero Trust existing-project selection is invalid');
  }
  const kind = input.kind as ZeroTrustOperation['kind'];
  const phase = input.phase as ZeroTrustOperation['phase'];
  if (
    (kind === 'disable' &&
      !['seed', 'projects', 'wildcard-delete', 'bypass-delete'].includes(phase)) ||
    (kind !== 'disable' && ['wildcard-delete', 'bypass-delete'].includes(phase))
  ) {
    throw new ZeroTrustConfigurationError('Zero Trust operation phase is inconsistent');
  }
  if (kind !== 'configure' && input.existingProjects !== null) {
    throw new ZeroTrustConfigurationError('Zero Trust existing-project selection is inconsistent');
  }
  if (input.applicationTarget !== undefined && kind !== 'reconcile') {
    throw new ZeroTrustConfigurationError('Zero Trust application target is inconsistent');
  }
  return {
    kind,
    phase,
    id: requiredText(input.id, 'operation id', 128),
    owner: input.owner === null ? null : requiredText(input.owner, 'operation owner', 128),
    leaseExpiresAt:
      input.leaseExpiresAt === null ? null : timestamp(input.leaseExpiresAt, 'operation lease'),
    startedAt: timestamp(input.startedAt, 'operation start timestamp'),
    existingProjects: input.existingProjects,
    ...(input.applicationTarget === undefined
      ? {}
      : { applicationTarget: parseZeroTrustApplicationTarget(input.applicationTarget) }),
  };
}

export function parseZeroTrustApplicationTarget(value: unknown): PlatformApplication {
  const input = record(value, 'application target');
  if (
    typeof input.dedicatedZone !== 'boolean' ||
    typeof input.zoneId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.zoneId) ||
    typeof input.zoneName !== 'string' ||
    !input.zoneName ||
    !input.workersDev
  ) {
    throw new ZeroTrustConfigurationError('Application target is invalid');
  }
  try {
    const application = readPlatformApplication({ PLATFORM_APPLICATION: JSON.stringify(input) });
    if (
      application.baseDomain !== application.zoneName &&
      !application.baseDomain.endsWith(`.${application.zoneName}`)
    ) {
      throw new Error('Application target is outside its zone');
    }
    return {
      ...application,
      workersDev: {
        subdomain: application.workersDev!.subdomain,
        installationId: application.workersDev!.installationId,
      },
    };
  } catch {
    throw new ZeroTrustConfigurationError('Application target is invalid');
  }
}

function parseZeroTrustConfiguration(value: unknown): ZeroTrustConfiguration | null {
  if (value === null || value === undefined) {
    return null;
  }
  const input = record(value, 'Zero Trust configuration');
  if (input.version !== 1) {
    throw new ZeroTrustConfigurationError('unsupported Zero Trust configuration version');
  }
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ZeroTrustConfigurationError('Zero Trust configuration revision is invalid');
  }
  if (typeof input.enabled !== 'boolean' || typeof input.protectNewProjects !== 'boolean') {
    throw new ZeroTrustConfigurationError('Zero Trust configuration flags are invalid');
  }
  if (
    (input.publicAccess !== undefined && input.publicAccess !== true) ||
    (input.managePublicCustomDomains !== undefined && input.managePublicCustomDomains !== true) ||
    (input.publicAccess && input.protectNewProjects)
  ) {
    throw new ZeroTrustConfigurationError('invalid public app access configuration');
  }
  const teamDomain = requiredText(input.teamDomain, 'Access team domain', 512).replace(/\/+$/, '');
  let parsedTeamDomain: URL;
  try {
    parsedTeamDomain = new URL(teamDomain);
  } catch {
    throw new ZeroTrustConfigurationError(
      'Access team domain must be an HTTPS cloudflareaccess.com origin',
    );
  }
  if (
    parsedTeamDomain.protocol !== 'https:' ||
    !parsedTeamDomain.hostname.endsWith('.cloudflareaccess.com') ||
    parsedTeamDomain.origin !== teamDomain
  ) {
    throw new ZeroTrustConfigurationError(
      'Access team domain must be an HTTPS cloudflareaccess.com origin',
    );
  }
  let publicAccessGuardDestination: string | undefined;
  if (input.publicAccess) {
    publicAccessGuardDestination = requiredText(
      input.publicAccessGuardDestination,
      'public app management destination',
      512,
    );
    try {
      if (
        publicAppManagementDestination('https://' + publicAccessGuardDestination) !==
        publicAccessGuardDestination
      ) {
        throw new Error('invalid destination');
      }
    } catch {
      throw new ZeroTrustConfigurationError('Invalid public app management destination');
    }
  }
  const wildcardApplication = parseApplication(input.wildcardApplication);
  // Configurations saved before the health exception existed have neither field.
  const healthApplication = parseApplication(input.healthApplication ?? null);
  const operation = parseOperation(input.operation);
  if (
    input.publicAccess &&
    (operation?.existingProjects === 'protected' ||
      (Array.isArray(input.identityProviderIds) && input.identityProviderIds.length > 0) ||
      (Array.isArray(input.policyIds) && input.policyIds.length > 0))
  ) {
    throw new ZeroTrustConfigurationError(
      'Public app access cannot contain identity policies or protected project choices',
    );
  }
  if (operation?.phase === 'bypass-delete' && (input.enabled || wildcardApplication)) {
    throw new ZeroTrustConfigurationError('Zero Trust bypass cleanup requires wildcard removal');
  }
  if (input.enabled && !wildcardApplication) {
    throw new ZeroTrustConfigurationError(
      'enabled Zero Trust configuration needs a managed Access application',
    );
  }
  return {
    version: 1,
    revision,
    enabled: input.enabled,
    protectNewProjects: input.protectNewProjects,
    accountId: requiredText(input.accountId, 'Cloudflare account id', 128),
    teamDomain,
    ...(input.publicAccess === true
      ? { publicAccess: true as const, publicAccessGuardDestination }
      : {}),
    ...(input.managePublicCustomDomains === true
      ? { managePublicCustomDomains: true as const }
      : {}),
    identityProviderIds: ids(
      input.identityProviderIds,
      'identity providers',
      input.publicAccess ? 0 : 1,
    ),
    policyIds: ids(input.policyIds, 'policies', input.publicAccess ? 0 : 1),
    credential: parseCredential(input.credential),
    wildcardApplicationName: requiredText(
      input.wildcardApplicationName,
      'managed application name',
      128,
    ),
    wildcardApplication,
    healthApplicationName:
      input.healthApplicationName === undefined || input.healthApplicationName === null
        ? null
        : requiredText(input.healthApplicationName, 'managed application name', 128),
    healthApplication,
    operation,
    lastError: input.lastError === null ? null : requiredText(input.lastError, 'last error', 4096),
    updatedAt: timestamp(input.updatedAt, 'updated timestamp'),
  };
}

export function normalizeZeroTrustConfigureInput(input: unknown): ZeroTrustConfigureInput {
  const value = record(input, 'Zero Trust configuration');
  if (typeof value.protectNewProjects !== 'boolean') {
    throw new ZeroTrustConfigurationError('protectNewProjects must be a boolean');
  }
  const existingProjects = value.existingProjects ?? undefined;
  if (
    existingProjects !== undefined &&
    existingProjects !== 'protected' &&
    existingProjects !== 'public'
  ) {
    throw new ZeroTrustConfigurationError('existingProjects must be protected or public');
  }
  const apiToken = requiredText(value.apiToken, 'Cloudflare API token', 8192);
  return {
    apiToken,
    ...(value.publicAccess === true
      ? { publicAccess: true as const, managePublicCustomDomains: true as const }
      : {}),
    identityProviderIds: ids(
      value.identityProviderIds,
      'identity providers',
      value.publicAccess === true ? 0 : 1,
    ),
    policyIds: ids(value.policyIds, 'policies', value.publicAccess === true ? 0 : 1),
    protectNewProjects: value.protectNewProjects,
    ...(existingProjects ? { existingProjects } : {}),
  };
}

export async function readZeroTrustConfigurationStrict(
  db: DbOrTx,
): Promise<ZeroTrustConfiguration | null> {
  const value = await getPlatformSetting(db, ZERO_TRUST_SETTING);
  try {
    return parseZeroTrustConfiguration(value);
  } catch (error) {
    if (error instanceof ZeroTrustConfigurationError) {
      throw new ZeroTrustSavedConfigurationError(error.message);
    }
    throw error;
  }
}

export async function writeZeroTrustConfiguration(
  db: DbOrTx,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  await setPlatformSetting(db, ZERO_TRUST_SETTING, configuration);
}

export async function replaceZeroTrustConfiguration(
  db: DbOrTx,
  expectedRevision: number,
  configuration: ZeroTrustConfiguration,
): Promise<boolean> {
  const rows = await db
    .update(platformSettings)
    .set({ value: configuration, updated_at: sql`now()` })
    .where(
      and(
        eq(platformSettings.key, ZERO_TRUST_SETTING),
        sql`(${platformSettings.value} ->> 'revision')::integer = ${expectedRevision}`,
      ),
    )
    .returning({ key: platformSettings.key });
  return rows.length === 1;
}

export function zeroTrustWildcardDestinations(
  application: PlatformApplication,
): ReadonlyArray<string> {
  return [
    ...new Set([
      ...(application.zoneName ? [`*.${application.baseDomain}`] : []),
      ...(application.workersDev
        ? [
            `${platformProjectIngressPrefix(application.workersDev)}*.${application.workersDev.subdomain}.workers.dev`,
          ]
        : []),
    ]),
  ];
}

export function redactedZeroTrustConfiguration(configuration: ZeroTrustConfiguration | null) {
  if (!configuration) {
    return { configured: false, enabled: false } as const;
  }
  const { credential: _credential, operation, ...visible } = configuration;
  return {
    configured: true,
    credentialConfigured: true,
    ...visible,
    status: zeroTrustConfigurationStatus(configuration),
    operation: operation
      ? {
          kind: operation.kind,
          phase: operation.phase,
          existingProjects: operation.existingProjects,
        }
      : null,
  } as const;
}
