import { createHash, randomBytes } from 'node:crypto';
import {
  type PlatformInstallationManifest,
  parsePlatformAuthenticationSetup,
} from '@void/platform';
import {
  checkpointPlatformAccessResources,
  isPlatformAuthenticationPreparationKey,
} from './platform-access-setup.ts';
import {
  type PlatformInstallationSecrets,
  type PlatformWorkerKey,
  type PlatformWorkerSecretUpdateIntent,
  type PlatformWorkerSecretUpdateName,
  PLATFORM_WORKER_SECRET_UPDATE_NAMES,
  type PlatformWorkerSecretUpdates,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan } from './platform-plan.ts';

export function createPlatformInstallationSecrets(input: {
  configurableAuthentication?: boolean;
  authenticationSetupJson?: string;
  authSetupToken?: string;
  authBootstrapCode?: string;
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  emailEnabled?: boolean;
  emailSigningSecret?: string;
  existingEmailEnabled?: boolean;
  githubClientId: string;
  githubClientSecret: string;
  existingInstallation?: boolean;
  /** Create missing identity keys for a fresh interactive install that keeps them in recovery data. */
  generateIdentityKeys?: boolean;
  /** The caller supplies current explicit rotation inputs, not resumed inputs. */
  updateExistingWorkers?: boolean;
  jwtSecret?: string;
  projectSecretActiveKeyVersion?: string;
  projectSecretKey?: string;
  projectSecretKeysJson?: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  checkpoint?: Record<string, string> | null;
}): PlatformInstallationSecrets {
  const checkpoint = input.checkpoint ?? {};
  // The two halves are one key pair. Replacing one half would leave the
  // Workers signing with a mismatched pair.
  if (!input.r2AccessKeyId !== !input.r2SecretAccessKey) {
    const [given, missing] = input.r2AccessKeyId
      ? ['VOID_PLATFORM_R2_ACCESS_KEY_ID', 'VOID_PLATFORM_R2_SECRET_ACCESS_KEY']
      : ['VOID_PLATFORM_R2_SECRET_ACCESS_KEY', 'VOID_PLATFORM_R2_ACCESS_KEY_ID'];
    throw new Error(
      `platform: ${given} is set but ${missing} is not. ` +
        'Set VOID_PLATFORM_R2_ACCESS_KEY_ID and VOID_PLATFORM_R2_SECRET_ACCESS_KEY together, ' +
        'even if only the secret changed.',
    );
  }
  const required = (value: string, name: string): string => {
    if (!value) {
      throw new Error(`platform: ${name} is required to install the platform.`);
    }
    return value;
  };
  // Runtime signing/encryption keys are installation identity, not ordinary
  // configuration. A checkpoint wins over the legacy single-key inputs. The
  // explicit complete-keyring pair is the only supported way to supersede a
  // stale encryption checkpoint, and existing Workers still inherit live keys.
  const existingInstallation = input.existingInstallation === true;
  const generateIdentityKeys = input.generateIdentityKeys === true && !existingInstallation;
  const restoredIdentity = (explicit: string, name: string): string =>
    existingInstallation ? checkpoint[name] || explicit || '' : explicit || checkpoint[name] || '';
  const configured = (explicit: string, name: string): string => explicit || checkpoint[name] || '';
  const authenticationSetupJson = configured(
    input.authenticationSetupJson ?? '',
    'authenticationSetupJson',
  );
  const authSetupToken = configured(input.authSetupToken ?? '', 'authSetupToken');
  const authBootstrapCode = configured(input.authBootstrapCode ?? '', 'authBootstrapCode');
  const modernAuthentication =
    input.configurableAuthentication === true || !!authenticationSetupJson;
  if (
    modernAuthentication &&
    !existingInstallation &&
    (authSetupToken.length < 32 || !/^[a-f0-9]{64}$/.test(authBootstrapCode))
  ) {
    throw new Error(
      'platform: Valid setup authority and an administrator setup code are required.',
    );
  }
  if (authenticationSetupJson) {
    const setup = parsePlatformAuthenticationSetup(JSON.parse(authenticationSetupJson));
    if (
      !existingInstallation &&
      createHash('sha256').update(authBootstrapCode).digest('hex') !== setup.bootstrapCredentialHash
    ) {
      throw new Error(
        'platform: Valid installation setup authority and a matching administrator setup code are required.',
      );
    }
  }
  const jwtSecret =
    restoredIdentity(input.jwtSecret || '', 'jwtSecret') ||
    (generateIdentityKeys ? randomBytes(32).toString('base64') : '');
  const resolvedJwtSecret = input.existingInstallation
    ? jwtSecret
    : required(jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
  if (!existingInstallation && Buffer.byteLength(resolvedJwtSecret, 'utf8') < 32) {
    throw new Error(
      'platform: VOID_PLATFORM_JWT_SECRET must contain at least 32 bytes of secret material unique to this installation.',
    );
  }
  const emailEnabled = input.emailEnabled === true;
  const existingEmailEnabled = input.existingEmailEnabled === true;
  const emailSigningSecretInScope = emailEnabled || existingEmailEnabled;
  let emailSigningSecret = emailSigningSecretInScope
    ? restoredIdentity(input.emailSigningSecret || '', 'emailSigningSecret')
    : checkpoint.emailSigningSecret || '';
  if (emailEnabled && !emailSigningSecret) {
    if (existingInstallation && existingEmailEnabled) {
      throw new Error(
        'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET is required to maintain an email-enabled installation without its encrypted recovery state.',
      );
    }
    emailSigningSecret = randomBytes(32).toString('base64');
  }
  if (
    emailSigningSecretInScope &&
    emailSigningSecret &&
    Buffer.byteLength(emailSigningSecret, 'utf8') < 32
  ) {
    throw new Error(
      'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET must contain at least 32 bytes of secret material unique to this installation.',
    );
  }
  if (emailSigningSecretInScope && emailSigningSecret && emailSigningSecret === resolvedJwtSecret) {
    throw new Error(
      'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET must be different from VOID_PLATFORM_JWT_SECRET.',
    );
  }
  const projectSecretKeyring = resolveProjectSecretKeyring({
    checkpoint,
    existingInstallation,
    generateIdentityKeys,
    projectSecretActiveKeyVersion: input.projectSecretActiveKeyVersion || '',
    projectSecretKey: input.projectSecretKey || '',
    projectSecretKeysJson: input.projectSecretKeysJson || '',
    required,
  });
  const pendingWorkerSecretUpdateIntent = parseWorkerSecretUpdateIntent(
    checkpoint.workerSecretUpdatesJson,
  );
  const emailSigningSecretUpdateAuthorized =
    emailSigningSecretInScope &&
    !!emailSigningSecret &&
    ((emailEnabled && (!existingEmailEnabled || !checkpoint.emailSigningSecret)) ||
      !!input.emailSigningSecret);
  const githubOptional = existingInstallation || modernAuthentication;
  const resolve = (
    key:
      | 'bootstrapGitHubId'
      | 'bootstrapGitHubLogin'
      | 'cloudflareApiToken'
      | 'githubClientId'
      | 'githubClientSecret'
      | 'r2AccessKeyId'
      | 'r2SecretAccessKey',
    requiredName: string,
    optional: boolean,
  ): string => {
    const value = configured(input[key], key);
    return optional ? value : required(value, requiredName);
  };
  const explicitWorkerSecretUpdates = withoutEmptySecrets({
    CF_API_TOKEN: input.cloudflareApiToken,
    ...(emailSigningSecretUpdateAuthorized ? { EMAIL_SIGNING_SECRET: emailSigningSecret } : {}),
    GITHUB_CLIENT_ID: input.githubClientId,
    GITHUB_CLIENT_SECRET: input.githubClientSecret,
    R2_ACCESS_KEY_ID: input.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: input.r2SecretAccessKey,
  });
  return {
    authenticationPreparation: Object.fromEntries(
      Object.entries(checkpoint).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
    ),
    ...(checkpoint.appAccessSetupToken
      ? { appAccessSetupToken: checkpoint.appAccessSetupToken }
      : {}),
    ...(checkpoint.appAccessSetupJson ? { appAccessSetupJson: checkpoint.appAccessSetupJson } : {}),
    ...(checkpoint.managementApiToken ? { managementApiToken: checkpoint.managementApiToken } : {}),
    ...(checkpoint.externalHyperdriveJson
      ? { externalHyperdriveJson: checkpoint.externalHyperdriveJson }
      : {}),
    ...(modernAuthentication ? { authenticationSetupJson, authSetupToken, authBootstrapCode } : {}),
    ...(checkpoint.accessProvisioningJson
      ? { accessProvisioningJson: checkpoint.accessProvisioningJson }
      : {}),
    ...(checkpoint.accessHealthProvisioningJson
      ? { accessHealthProvisioningJson: checkpoint.accessHealthProvisioningJson }
      : {}),
    ...(checkpoint.accessCredentialsJson
      ? { accessCredentialsJson: checkpoint.accessCredentialsJson }
      : {}),
    workerSecretUpdates: input.updateExistingWorkers ? explicitWorkerSecretUpdates : {},
    pendingWorkerSecretUpdateIntent: input.updateExistingWorkers
      ? pendingWorkerSecretUpdateIntent
      : undefined,
    bootstrapGitHubId: resolve(
      'bootstrapGitHubId',
      'resolved administrator GitHub account id',
      githubOptional,
    ),
    bootstrapGitHubLogin: resolve(
      'bootstrapGitHubLogin',
      'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
      githubOptional,
    ),
    cloudflareApiToken: resolve(
      'cloudflareApiToken',
      'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN',
      existingInstallation,
    ),
    databaseUrl: required(input.databaseUrl || checkpoint.databaseUrl || '', 'DATABASE_URL'),
    emailEnabled,
    emailSigningSecret,
    githubClientId: resolve('githubClientId', 'VOID_PLATFORM_GITHUB_CLIENT_ID', githubOptional),
    githubClientSecret: resolve(
      'githubClientSecret',
      'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
      githubOptional,
    ),
    jwtSecret: resolvedJwtSecret,
    projectSecretActiveKeyVersion: projectSecretKeyring.activeVersion,
    projectSecretKey: projectSecretKeyring.v1Key,
    projectSecretKeysJson: projectSecretKeyring.keysJson,
    r2AccessKeyId: resolve('r2AccessKeyId', 'VOID_PLATFORM_R2_ACCESS_KEY_ID', existingInstallation),
    r2SecretAccessKey: resolve(
      'r2SecretAccessKey',
      'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
      existingInstallation,
    ),
  };
}

function resolveProjectSecretKeyring(input: {
  checkpoint: Record<string, string>;
  existingInstallation: boolean;
  generateIdentityKeys: boolean;
  projectSecretActiveKeyVersion: string;
  projectSecretKey: string;
  projectSecretKeysJson: string;
  required: (value: string, name: string) => string;
}): Readonly<{ activeVersion: string; keysJson: string; v1Key: string }> {
  const explicitFullKeyring =
    input.projectSecretKeysJson !== '' || input.projectSecretActiveKeyVersion !== '';
  if (
    explicitFullKeyring &&
    (!input.projectSecretKeysJson || !input.projectSecretActiveKeyVersion)
  ) {
    throw new Error(
      'platform: VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON and VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION must be supplied together.',
    );
  }
  if (explicitFullKeyring && !input.existingInstallation) {
    throw new Error(
      'platform: Fresh installations use VOID_PLATFORM_PROJECT_SECRET_KEY to initialize key version v1. The full project-secret keyring inputs are for restoring an existing installation.',
    );
  }

  const checkpointKeysJson = input.checkpoint.projectSecretKeysJson || '';
  const checkpointActiveVersion = input.checkpoint.projectSecretActiveKeyVersion || '';
  if (
    !explicitFullKeyring &&
    (checkpointKeysJson !== '' || checkpointActiveVersion !== '') &&
    (!checkpointKeysJson || !checkpointActiveVersion)
  ) {
    throw new Error(
      'platform: Encrypted recovery material must contain both the project-secret keyring and its active version.',
    );
  }

  if (explicitFullKeyring) {
    return normalizeProjectSecretKeyring(
      input.projectSecretKeysJson,
      input.projectSecretActiveKeyVersion,
      'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON',
      'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION',
    );
  }
  if (checkpointKeysJson) {
    return normalizeProjectSecretKeyring(
      checkpointKeysJson,
      checkpointActiveVersion,
      'encrypted recovery project-secret keyring',
      'encrypted recovery project-secret active version',
    );
  }

  const v1Key = input.existingInstallation
    ? input.checkpoint.projectSecretKey || input.projectSecretKey || ''
    : input.required(
        input.projectSecretKey ||
          input.checkpoint.projectSecretKey ||
          (input.generateIdentityKeys ? randomBytes(32).toString('base64') : ''),
        'VOID_PLATFORM_PROJECT_SECRET_KEY',
      );
  if (!v1Key) {
    return { activeVersion: '', keysJson: '', v1Key: '' };
  }
  assertCanonicalProjectSecretKey(v1Key, 'VOID_PLATFORM_PROJECT_SECRET_KEY', true);
  return {
    activeVersion: 'v1',
    keysJson: JSON.stringify({ v1: v1Key }),
    v1Key,
  };
}

function normalizeProjectSecretKeyring(
  keysJson: string,
  activeVersion: string,
  keysName: string,
  activeVersionName: string,
): Readonly<{ activeVersion: string; keysJson: string; v1Key: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error(`platform: ${keysName} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`platform: ${keysName} must be a JSON object.`);
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error(`platform: ${keysName} must define at least one key.`);
  }
  for (const [version, key] of entries) {
    if (!version || typeof key !== 'string' || !key) {
      throw new Error(`platform: ${keysName} must map non-empty versions to keys.`);
    }
    assertCanonicalProjectSecretKey(key, `${keysName} entry ${JSON.stringify(version)}`);
  }
  if (!Object.hasOwn(parsed, activeVersion)) {
    throw new Error(`platform: ${activeVersionName} must identify a key in ${keysName}.`);
  }
  const keys = Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>;
  return {
    activeVersion,
    keysJson: JSON.stringify(keys),
    v1Key: keys.v1 || '',
  };
}

function assertCanonicalProjectSecretKey(
  value: string,
  name: string,
  uniqueToInstallation = false,
): void {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(
      `platform: ${name} must be the canonical base64 encoding of a 32-byte key${uniqueToInstallation ? ' unique to this installation' : ''}.`,
    );
  }
}

export function secretCheckpoint(
  secrets: PlatformInstallationSecrets,
  workerSecretUpdateIntent?: PlatformWorkerSecretUpdateIntent | null,
): Record<string, string> {
  return {
    ...(secrets.appAccessSetupToken ? { appAccessSetupToken: secrets.appAccessSetupToken } : {}),
    ...(secrets.appAccessSetupJson ? { appAccessSetupJson: secrets.appAccessSetupJson } : {}),
    ...(secrets.managementApiToken ? { managementApiToken: secrets.managementApiToken } : {}),
    ...(secrets.externalHyperdriveJson
      ? { externalHyperdriveJson: secrets.externalHyperdriveJson }
      : {}),
    ...Object.fromEntries(
      Object.entries(secrets.authenticationPreparation ?? {}).filter(([name]) =>
        isPlatformAuthenticationPreparationKey(name),
      ),
    ),
    ...(secrets.authSetupToken
      ? {
          authenticationSetupJson: secrets.authenticationSetupJson ?? '',
          authSetupToken: secrets.authSetupToken ?? '',
          authBootstrapCode: secrets.authBootstrapCode ?? '',
        }
      : {}),
    ...(secrets.accessProvisioningJson
      ? { accessProvisioningJson: secrets.accessProvisioningJson }
      : {}),
    ...(secrets.accessHealthProvisioningJson
      ? { accessHealthProvisioningJson: secrets.accessHealthProvisioningJson }
      : {}),
    ...(secrets.accessCredentialsJson
      ? { accessCredentialsJson: secrets.accessCredentialsJson }
      : {}),
    bootstrapGitHubId: secrets.bootstrapGitHubId,
    bootstrapGitHubLogin: secrets.bootstrapGitHubLogin,
    cloudflareApiToken: secrets.cloudflareApiToken,
    databaseUrl: secrets.databaseUrl,
    githubClientId: secrets.githubClientId,
    githubClientSecret: secrets.githubClientSecret,
    jwtSecret: secrets.jwtSecret,
    emailSigningSecret: secrets.emailSigningSecret,
    projectSecretActiveKeyVersion: secrets.projectSecretActiveKeyVersion,
    projectSecretKey: secrets.projectSecretKey,
    projectSecretKeysJson: secrets.projectSecretKeysJson,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2SecretAccessKey: secrets.r2SecretAccessKey,
    ...(workerSecretUpdateIntent
      ? { workerSecretUpdatesJson: JSON.stringify(workerSecretUpdateIntent) }
      : {}),
  };
}

function parseWorkerSecretUpdateIntent(
  value: string | undefined,
): PlatformWorkerSecretUpdateIntent | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('platform: Encrypted pending Worker secret updates must be valid JSON.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('schema' in parsed) ||
    parsed.schema !== 1 ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    parsed.id === '' ||
    !('baselineGeneration' in parsed) ||
    !Number.isSafeInteger(parsed.baselineGeneration) ||
    Number(parsed.baselineGeneration) < 0 ||
    !('generation' in parsed) ||
    (parsed.generation !== null &&
      (!Number.isSafeInteger(parsed.generation) || Number(parsed.generation) <= 0)) ||
    !('updates' in parsed) ||
    !parsed.updates ||
    typeof parsed.updates !== 'object' ||
    Array.isArray(parsed.updates)
  ) {
    throw new Error('platform: Encrypted pending Worker secret update intent is invalid.');
  }
  const updates: Partial<Record<PlatformWorkerSecretUpdateName, string>> = {};
  for (const [name, entry] of Object.entries(parsed.updates)) {
    if (
      !PLATFORM_WORKER_SECRET_UPDATE_NAMES.includes(name as PlatformWorkerSecretUpdateName) ||
      typeof entry !== 'string' ||
      entry === ''
    ) {
      throw new Error('platform: Encrypted pending Worker secret updates are invalid.');
    }
    updates[name as PlatformWorkerSecretUpdateName] = entry;
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('platform: Encrypted pending Worker secret update intent is empty.');
  }
  return {
    baselineGeneration: Number(parsed.baselineGeneration),
    generation: parsed.generation === null ? null : Number(parsed.generation),
    id: parsed.id,
    schema: 1,
    updates,
  };
}

export function sanitizeWorkerSecretUpdates(
  updates: PlatformInstallationSecrets['workerSecretUpdates'],
): PlatformWorkerSecretUpdates {
  return Object.fromEntries(
    Object.entries(updates ?? {}).filter(
      ([name, value]) =>
        PLATFORM_WORKER_SECRET_UPDATE_NAMES.includes(name as PlatformWorkerSecretUpdateName) &&
        typeof value === 'string' &&
        value !== '',
    ),
  );
}

export function checkpointAuthenticationResources(
  manifest: PlatformInstallationManifest,
  secrets: PlatformInstallationSecrets,
  updatedAt: string,
): PlatformInstallationManifest {
  return checkpointPlatformAccessResources(
    checkpointPlatformAccessResources(manifest, secrets.accessProvisioningJson, updatedAt),
    secrets.accessHealthProvisioningJson,
    updatedAt,
  );
}

export function apiWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
): Record<string, string> {
  return withoutEmptySecrets({
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    CF_ZONE_ID: zoneId,
    GITHUB_CLIENT_ID: secrets.githubClientId,
    GITHUB_CLIENT_SECRET: secrets.githubClientSecret,
    ...(secrets.emailEnabled ? { EMAIL_SIGNING_SECRET: secrets.emailSigningSecret } : {}),
    JWT_SECRET: secrets.jwtSecret,
    PLATFORM_BOOTSTRAP_GITHUB_ID: secrets.bootstrapGitHubId,
    PLATFORM_AUTH_SETUP_TOKEN: secrets.authSetupToken ?? '',
    PLATFORM_APP_ACCESS_SETUP_TOKEN: secrets.appAccessSetupToken ?? '',
    ...(secrets.projectSecretKeysJson && secrets.projectSecretActiveKeyVersion
      ? {
          PROJECT_SECRET_ACTIVE_KEY_VERSION: secrets.projectSecretActiveKeyVersion,
          PROJECT_SECRET_KEYS_JSON: secrets.projectSecretKeysJson,
        }
      : {}),
    R2_ACCESS_KEY_ID: secrets.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: secrets.r2SecretAccessKey,
  });
}

/** Existing Workers inherit live secrets, including complete encryption keyrings. */
export function platformWorkerSecretPayload(
  worker: PlatformWorkerKey,
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
  existingWorker: boolean,
): Record<string, string> | null {
  if (worker !== 'api' && worker !== 'proxy' && worker !== 'emailGateway') {
    return null;
  }
  if (!existingWorker) {
    if (worker === 'api') {
      return apiWorkerSecrets(secrets, accountId, zoneId);
    }
    if (worker === 'emailGateway') {
      const payload = withoutEmptySecrets({
        EMAIL_SIGNING_SECRET: secrets.emailEnabled ? secrets.emailSigningSecret : '',
      });
      return Object.keys(payload).length > 0 ? payload : null;
    }
    return proxyWorkerSecrets(secrets, accountId);
  }
  const allowed: ReadonlyArray<string> =
    worker === 'api'
      ? PLATFORM_WORKER_SECRET_UPDATE_NAMES
      : worker === 'proxy'
        ? ['CF_API_TOKEN', 'EMAIL_SIGNING_SECRET']
        : ['EMAIL_SIGNING_SECRET'];
  const updates = Object.fromEntries(
    Object.entries(secrets.workerSecretUpdates ?? {}).filter(
      ([name, value]) => allowed.includes(name) && typeof value === 'string' && value !== '',
    ),
  );
  return Object.keys(updates).length > 0 ? updates : null;
}

export async function resolveBootstrapGitHubId(
  login: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const normalizedLogin = login.trim();
  if (!normalizedLogin) {
    throw new Error('platform: VOID_PLATFORM_ADMIN_GITHUB_LOGIN is required.');
  }
  const response = await fetcher(
    `https://api.github.com/users/${encodeURIComponent(normalizedLogin)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-platform-installer',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `platform: Could not resolve GitHub user ${JSON.stringify(normalizedLogin)} (HTTP ${response.status}). Verify the username and retry.`,
    );
  }
  const body = (await response.json()) as { id?: unknown };
  const id = typeof body.id === 'number' && Number.isSafeInteger(body.id) ? String(body.id) : '';
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(
      'platform: GitHub returned an invalid account id for the initial administrator.',
    );
  }
  return id;
}

function proxyWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
): Record<string, string> {
  return withoutEmptySecrets({
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    ...(secrets.emailEnabled ? { EMAIL_SIGNING_SECRET: secrets.emailSigningSecret } : {}),
    JWT_SECRET: secrets.jwtSecret,
  });
}

function withoutEmptySecrets(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ''));
}

export function assertRequiredPlatformSecrets(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  secrets: PlatformInstallationSecrets,
  authenticationWillBePrepared = false,
): void {
  const missing = new Set<string>();
  const requireSecret = (value: string, name: string) => {
    if (!value) {
      missing.add(name);
    }
  };
  if (
    plan.deployment.authentication.configurable &&
    !manifest.steps.some((step) => step.key.startsWith('authentication-initialized:v1:')) &&
    !(
      manifest.deployment.authentication.configurable &&
      manifest.steps.some((step) => step.key === 'bootstrap-access:v1')
    )
  ) {
    if (!authenticationWillBePrepared) {
      requireSecret(secrets.authenticationSetupJson ?? '', 'authentication setup configuration');
    }
    requireSecret(secrets.authSetupToken ?? '', 'installation authentication setup authority');
    requireSecret(secrets.authBootstrapCode ?? '', 'administrator setup code');
  } else if (
    !plan.deployment.authentication.configurable &&
    !manifest.steps.some((step) => step.key === 'bootstrap-access:v1')
  ) {
    requireSecret(secrets.bootstrapGitHubId, 'VOID_PLATFORM_ADMIN_GITHUB_ID');
    requireSecret(secrets.bootstrapGitHubLogin, 'VOID_PLATFORM_ADMIN_GITHUB_LOGIN');
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'api-worker' && action.kind === 'worker' && action.action === 'create',
    )
  ) {
    requireSecret(secrets.cloudflareApiToken, 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
    if (!plan.deployment.authentication.configurable) {
      requireSecret(secrets.githubClientId, 'VOID_PLATFORM_GITHUB_CLIENT_ID');
      requireSecret(secrets.githubClientSecret, 'VOID_PLATFORM_GITHUB_CLIENT_SECRET');
    }
    requireSecret(secrets.jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
    requireSecret(
      secrets.projectSecretKeysJson,
      'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON (or VOID_PLATFORM_PROJECT_SECRET_KEY for v1)',
    );
    requireSecret(
      secrets.projectSecretActiveKeyVersion,
      'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION (or VOID_PLATFORM_PROJECT_SECRET_KEY for v1)',
    );
    requireSecret(secrets.r2AccessKeyId, 'VOID_PLATFORM_R2_ACCESS_KEY_ID');
    requireSecret(secrets.r2SecretAccessKey, 'VOID_PLATFORM_R2_SECRET_ACCESS_KEY');
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'proxy-worker' && action.kind === 'worker' && action.action === 'create',
    )
  ) {
    requireSecret(secrets.cloudflareApiToken, 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
    requireSecret(secrets.jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'email-gateway-worker' &&
        action.kind === 'worker' &&
        action.action === 'create',
    )
  ) {
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `platform: Creating a missing platform Worker requires: ${[...missing].sort().join(', ')}. Restore these values from your secret manager and retry.`,
    );
  }
}

export function createPlatformHealthProbeToken(ownershipNonce: string): string {
  return createHash('sha256')
    .update('void-platform-health-probe:v1\0')
    .update(ownershipNonce)
    .digest('base64url');
}
