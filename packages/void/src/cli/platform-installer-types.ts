import { type CloudflareTriggerConfig } from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  type PlatformInstallationManifest,
  type PlatformLifecycleOperation,
  type PlatformAccessProtection,
  type PlatformLoginKind,
} from '@void/platform';
import type {
  PlatformRuntime,
  PlatformRuntimeDatabaseManifest,
  PlatformRuntimeMigration,
} from '@void/platform/installer';
import type { ensurePlatformAccessHealthChecks } from './platform-access-health.ts';
import type { verifyInstalledPlatformAccessProtection } from './platform-access-preflight.ts';
import type { initializeInstalledAppAccess } from './platform-app-access.ts';
import type { initializeInstalledPlatformAuthentication } from './platform-auth-bootstrap.ts';
import {
  type CloudflareWorkerCustomDomainOrigin,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import type {
  bootstrapPlatformSharedEmail,
  verifyPlatformHealth,
  verifyPlatformDeploymentExecutionDrain,
} from './platform-installer-health.ts';
import type { runPlatformWrangler } from './platform-installer-workers.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import { type PlatformProjectZeroTrustState } from './platform-zero-trust-uninstall.ts';

export type PlatformInstallationSecrets = Readonly<{
  appAccessSetupJson?: string;
  appAccessSetupToken?: string;
  /** Local operator credential, never included in Worker secrets. */
  managementApiToken?: string;
  /** Retain external selection details until an adoption receipt can identify the resource. */
  externalHyperdriveJson?: string;
  authenticationPreparation?: Readonly<Record<string, string>>;
  accessProvisioningJson?: string;
  accessHealthProvisioningJson?: string;
  accessCredentialsJson?: string;
  authenticationSetupJson?: string;
  authSetupToken?: string;
  authBootstrapCode?: string;
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  emailEnabled: boolean;
  emailSigningSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  jwtSecret: string;
  projectSecretActiveKeyVersion: string;
  projectSecretKey: string;
  projectSecretKeysJson: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  /** Explicitly authorized updates; recovered email identity remains authoritative. */
  workerSecretUpdates?: Readonly<
    Partial<
      Record<
        | 'CF_API_TOKEN'
        | 'EMAIL_SIGNING_SECRET'
        | 'GITHUB_CLIENT_ID'
        | 'GITHUB_CLIENT_SECRET'
        | 'R2_ACCESS_KEY_ID'
        | 'R2_SECRET_ACCESS_KEY',
        string
      >
    >
  >;
  /** Encrypted recovery intent; applied only while its Worker cutover is authoritative. */
  pendingWorkerSecretUpdateIntent?: PlatformWorkerSecretUpdateIntent;
}>;

export const PLATFORM_WORKER_SECRET_UPDATE_NAMES = [
  'CF_API_TOKEN',
  'EMAIL_SIGNING_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

export type PlatformWorkerSecretUpdateName = (typeof PLATFORM_WORKER_SECRET_UPDATE_NAMES)[number];

export type PlatformWorkerSecretUpdates = Partial<Record<PlatformWorkerSecretUpdateName, string>>;

export type PlatformWorkerSecretUpdateIntent = Readonly<{
  baselineGeneration: number;
  generation: number | null;
  id: string;
  schema: 1;
  updates: Readonly<PlatformWorkerSecretUpdates>;
}>;

export type PlatformAdministratorSetupState = Readonly<{
  /** A setup row exists that no administrator has used yet. */
  pending: boolean;
  usersExist: boolean;
  /** Hash of the login settings the platform last accepted, or null before setup started. */
  requestHash: string | null;
}>;

export type PlatformDatabaseLifecycleLock = (() => Promise<void>) & {
  readAuthenticationState?: () => Promise<{
    enabledProviders: ReadonlyArray<PlatformLoginKind>;
    sessionsRequired: boolean;
    protectedByAccess: boolean;
    protection?: PlatformAccessProtection | null;
  } | null>;
  authoritativeManifest?: PlatformInstallationManifest | null;
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
  prepareSandboxDrain?: (
    requiredAdmissionProtocol?: 0 | 2 | 3,
  ) => Promise<PlatformSandboxDrainPreparation>;
  /** First administrator setup state; repair replaces its login settings only while pending. */
  readAdministratorSetup?: () => Promise<PlatformAdministratorSetupState>;
  /** Project Zero Trust state that decides whether uninstall may start. */
  readProjectZeroTrust?: () => Promise<PlatformProjectZeroTrustState>;
  /** Project slugs, which --purge-resources requires to be empty. */
  readProjects?: () => Promise<ReadonlyArray<string>>;
  /** Block Zero Trust writers in the API until the returned release runs. */
  lockProjectZeroTrust?: () => Promise<() => Promise<void>>;
  /** Make API Zero Trust writers refuse until the fence is lifted. */
  fenceProjectZeroTrust?: () => Promise<void>;
  /** Let API Zero Trust writers run again; called before traffic is enabled. */
  liftProjectZeroTrustFence?: () => Promise<void>;
  requiredSafetyProtocols?: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>;
  verifyDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
  ) => Promise<void>;
};

type PlatformLiveAuthenticationState = NonNullable<
  Awaited<ReturnType<NonNullable<PlatformDatabaseLifecycleLock['readAuthenticationState']>>>
>;

/** Preserve database-authoritative authentication choices while upgrading old manifests. */
export function mergePlatformLiveAuthenticationDeployment(
  deployment: PlatformInstallationManifest['deployment'],
  live: PlatformLiveAuthenticationState,
): PlatformInstallationManifest['deployment'] {
  const providers =
    live.enabledProviders.length > 0 ? live.enabledProviders : deployment.authentication.providers;
  return createPlatformDeploymentManifest({
    ...deployment,
    authentication: {
      providers,
      ...(live.sessionsRequired ? { configurable: true as const } : {}),
      ...(live.protectedByAccess ? { accessProtection: true as const } : {}),
    },
    capabilities: {
      ...deployment.capabilities,
      githubOAuth: providers.includes('github'),
      googleOAuth: providers.includes('google'),
    },
  });
}

export type PlatformDatabaseState = Readonly<{
  pendingMigrations: ReadonlyArray<PlatformRuntimeMigration>;
  schemaDigest: string;
}>;

export type PlatformSandboxDrainPreparation = Readonly<{
  admissionProtocol: 0 | 2 | 3;
  generation: string;
  state: 'complete' | 'pending';
}>;

export type PlatformDatabaseMigrationResult = Readonly<{
  appliedMigrations: number;
  previousSchemaDigest: string;
  schemaDigest: string;
}>;

export type InstallerClient = Pick<
  PlatformCloudflareClient,
  | 'apiBaseUrl'
  | 'createDispatchNamespace'
  | 'createDnsRecord'
  | 'createAiGateway'
  | 'createHyperdrive'
  | 'getHyperdriveConfig'
  | 'disableHyperdriveCaching'
  | 'createKvNamespace'
  | 'createQueue'
  | 'createR2Bucket'
  | 'createZone'
  | 'deleteKvValue'
  | 'getWorkerPlainTextBindings'
  | 'listWorkerDomains'
  | 'listWorkerNames'
  | 'listWorkerRoutes'
  | 'listWorkerServiceRoutes'
  | 'publishWorkerCustomDomainsSafely'
  | 'publishWorkerRoutesSafely'
  | 'putKvValue'
  | 'putR2Object'
  | 'request'
>;

export type WorkerInspectionClient = Pick<
  PlatformCloudflareClient,
  'getWorkerPlainTextBindings' | 'listWorkerNames'
>;

export type PlatformWorkerRollback = () => Promise<void>;

export class PlatformWorkerRecoveryIncompleteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerRecoveryIncompleteError';
  }
}

export type PlatformInstallerDependencies = Readonly<{
  prepareAppAccess?: (
    manifest: PlatformInstallationManifest,
    secrets: PlatformInstallationSecrets,
  ) => Promise<string>;
  initializeAppAccess?: typeof initializeInstalledAppAccess;
  prepareAuthentication?: (
    manifest: PlatformInstallationManifest,
    secrets: PlatformInstallationSecrets,
  ) => Promise<
    Partial<
      Pick<
        PlatformInstallationSecrets,
        | 'authenticationSetupJson'
        | 'authSetupToken'
        | 'authBootstrapCode'
        | 'accessProvisioningJson'
        | 'accessCredentialsJson'
      >
    >
  >;
  initializeAuthentication?: typeof initializeInstalledPlatformAuthentication;
  verifyAccessProtection?: typeof verifyInstalledPlatformAccessProtection;
  prepareHealthAccess?: typeof ensurePlatformAccessHealthChecks;
  acquireDatabaseLifecycleLock: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<PlatformDatabaseLifecycleLock>;
  claimDatabase?: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<void>;
  client: InstallerClient;
  /** The operator bearer used by client, separate from credentials deployed to Workers. */
  operatorApiToken?: string;
  databaseRollbackSource?: PlatformRuntime;
  deployWorker?: (
    config: Record<string, unknown>,
    secrets: Record<string, string> | null,
    previousConfig: Record<string, unknown>,
  ) => Promise<PlatformWorkerRollback | void>;
  now?: () => string;
  onProgress?: (message: string) => void;
  operation?: PlatformLifecycleOperation['action'];
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
  prepareSandboxDrain?: (
    requiredAdmissionProtocol?: 0 | 2 | 3,
  ) => Promise<PlatformSandboxDrainPreparation>;
  recoverWorkerCutover?: (input: {
    key: PlatformWorkerKey;
    preserveCustomDomains: boolean;
    previousVersionId: string | null;
    stagedVersionId: string;
    workerName: string;
  }) => Promise<void>;
  replanWorkers?: (
    manifest: PlatformInstallationManifest,
  ) => Promise<ReadonlyArray<PlatformInstallPlanAction>>;
  /** Workers whose changes made outside Void the operator agreed to replace. */
  replaceOutsideChanges?: ReadonlyArray<string>;
  /**
   * Upload a version of each Worker in replaceOutsideChanges, and do not deploy
   * it. The installer gives the configs that the run deploys. It calls this
   * after it creates the resources that the configs use, and before it pauses
   * traffic.
   */
  uploadOutsideChanges?: (configs: ReadonlyArray<Record<string, unknown>>) => Promise<void>;
  revalidateBeforeWorkerDeploy: (
    manifest: PlatformInstallationManifest,
    action: PlatformInstallPlanAction,
  ) => Promise<void>;
  runtime?: PlatformRuntime;
  verifyExistingOwnership?: (
    manifest: PlatformInstallationManifest,
    databaseCheckpointExists: boolean,
  ) => Promise<void>;
  healthCheckResumeCommand?: string;
  bootstrapEmail?: typeof bootstrapPlatformSharedEmail;
  verifyHealth?: typeof verifyPlatformHealth;
  verifySandboxDrain?: (apiUrl: string, healthProbeToken: string) => Promise<boolean>;
  verifyDeploymentExecutionDrain?: typeof verifyPlatformDeploymentExecutionDrain;
  verifyWorkerCutover?: (
    manifest: PlatformInstallationManifest,
    generation: number,
  ) => Promise<void>;
}>;

/** What installPlatform and its phases update while an installation runs. */
export type PlatformInstallRunState = {
  manifest: PlatformInstallationManifest;
  plan: PlatformInstallPlan;
  secrets: PlatformInstallationSecrets;
  workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null;
  workerCutoverGeneration: number;
  workerRollbacks: Array<PlatformWorkerRollback>;
  workerDeploymentCommitted: boolean;
  authenticationEnforcementActive: boolean;
};

export type PlatformInstallationResult = Readonly<{
  emailOperationId?: string;
  manifest: PlatformInstallationManifest;
  setupPending?: boolean;
  waitingForDns: boolean;
  waitingForSandboxDrain: boolean;
  zoneNameServers: ReadonlyArray<string>;
}>;

export type InstallationCheckpointWriter = (
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
) => Promise<void>;

export type PlatformWorkerDeploymentOptions = Readonly<{
  apiBaseUrl: string;
  operatorApiToken?: string;
  readCloudflare?: (path: string) => Promise<unknown>;
  acquireUploadSlot?: () => Promise<(failure?: unknown) => void>;
  onReadyForActivation?: () => Promise<void>;
  waitForPriorWorker?: () => Promise<void>;
  inspectNewWorker: () => Promise<'missing' | 'owned'>;
  onStaged: (
    previousVersionId: string | null,
    stagedVersionId: string,
    previousTriggers: CloudflareTriggerConfig,
  ) => Promise<void>;
  onTrafficPublished: () => Promise<void>;
  onUnsafeTraffic: () => Promise<void>;
  managedRoutes: ReadonlyArray<string>;
  previousConfig: Record<string, unknown>;
  previousPublicEndpoints: boolean;
  preservedRoutes: ReadonlyArray<unknown>;
  publishCustomDomains: (
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ) => Promise<void>;
  publishRoutes: (workerName: string, patterns: ReadonlyArray<string>) => Promise<void>;
  retainNewWorker: () => Promise<void>;
  /** False uploads a new version even when the active one has identical input. */
  reuseMatchingVersion?: boolean;
  /**
   * The operator agreed to replace changes made to this Worker outside Void.
   * Its active version can then lack Void's record of its triggers.
   */
  replaceOutsideChanges?: boolean;
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
}>;

export type ConditionalWorkerCreateState = {
  assetSessionStarted: boolean;
  attempted: boolean;
  conflictStatus: number | null;
  created: boolean;
  forwarded: boolean;
  rejectedMutation: string | null;
};

export type ConditionalWorkerCreateProxy = Readonly<{
  apiBaseUrl: string;
  close: () => Promise<void>;
  state: ConditionalWorkerCreateState;
}>;

export type PlatformWorkerDeployment = Readonly<{
  id: string;
  versions: ReadonlyArray<Readonly<{ percentage: number; versionId: string }>>;
}>;

export type PlatformWorkerKey = 'api' | 'proxy' | 'emailGateway' | 'tail' | 'dispatch';

export type PlatformWorkerCutoverSnapshot = Readonly<{
  previousVersionId: string | null;
  previousTriggers: CloudflareTriggerConfig;
  stagedVersionId: string;
  workerName: string;
}>;

export type InterruptedWorkerCutover = Readonly<{
  generation: number;
  staged: ReadonlyMap<PlatformWorkerKey, PlatformWorkerCutoverSnapshot>;
  unsafeTraffic: ReadonlySet<PlatformWorkerKey>;
}>;

export type PlatformHealthCheckContext = Readonly<{
  accountName: string;
  accessProtected?: boolean;
  workers: ReadonlyArray<string>;
  resumeCommand?: string;
  emailGatewayUrl?: string;
}>;
