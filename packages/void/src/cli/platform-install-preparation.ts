import { createHash, randomBytes } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  platformDashboardUrl,
  transitionInstallation,
  parsePlatformAuthenticationSetup,
} from '@void/platform';
import type { PlatformDeploymentManifest } from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { ensurePlatformAccessHealthChecks } from './platform-access-health.ts';
import { verifyInstalledPlatformAccessProtection } from './platform-access-preflight.ts';
import {
  mergePlatformAccessCredentials,
  isPlatformAuthenticationPreparationKey,
} from './platform-access-setup.ts';
import { PlatformAppAccessCredentialError } from './platform-app-access.ts';
import { PlatformCloudflareApiError } from './platform-cloudflare.ts';
import { verifyPlatformDeploymentExecutionDrain } from './platform-installer-health.ts';
import {
  assertRequiredPlatformSecrets,
  secretCheckpoint,
  checkpointAuthenticationResources,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';
import { mergePlatformLiveAuthenticationDeployment } from './platform-installer-types.ts';
import type {
  PlatformDatabaseLifecycleLock,
  PlatformInstallerDependencies,
  PlatformInstallRunState,
  PlatformLiveAuthenticationState,
} from './platform-installer-types.ts';
import {
  readPendingInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';

function withAuthentication(
  deployment: PlatformDeploymentManifest,
  authentication: PlatformDeploymentManifest['authentication'],
): PlatformDeploymentManifest {
  return createPlatformDeploymentManifest({
    ...deployment,
    authentication,
    capabilities: {
      ...deployment.capabilities,
      githubOAuth: authentication.providers.includes('github'),
      googleOAuth: authentication.providers.includes('google'),
    },
  });
}

type InstallationAuthenticationInput = Readonly<{
  state: PlatformInstallRunState;
  runtime: PlatformRuntimeManifest;
  authenticationProtocolTransition: boolean;
  dependencies: PlatformInstallerDependencies;
}>;

function applyInstallationAuthentication(
  { state, runtime, authenticationProtocolTransition }: InstallationAuthenticationInput,
  liveAuthentication: PlatformLiveAuthenticationState | null | undefined,
): void {
  if (liveAuthentication) {
    state.authenticationEnforcementActive = liveAuthentication.sessionsRequired;
    if (liveAuthentication.sessionsRequired && runtime.authenticationProtocolVersion !== 1) {
      throw new Error(
        'platform: This runtime cannot enforce the active authentication configuration. Use an authentication-compatible runtime.',
      );
    }
    const deployment = mergePlatformLiveAuthenticationDeployment(
      state.plan.deployment,
      liveAuthentication,
    );
    state.plan = { ...state.plan, deployment };
    if (!authenticationProtocolTransition) {
      state.manifest = { ...state.manifest, deployment };
    }
  }
  if (
    !liveAuthentication &&
    state.manifest.deployment.authentication.configurable &&
    !state.plan.deployment.authentication.configurable
  ) {
    state.plan = {
      ...state.plan,
      deployment: withAuthentication(
        state.plan.deployment,
        state.manifest.deployment.authentication,
      ),
    };
  }
  if (authenticationProtocolTransition && !state.plan.deployment.authentication.configurable) {
    state.plan = {
      ...state.plan,
      deployment: withAuthentication(state.plan.deployment, {
        providers: state.plan.deployment.authentication.providers,
        configurable: true,
      }),
    };
  }
}

async function verifyInstallationAccessSetup(
  { state, dependencies }: InstallationAuthenticationInput,
  liveAuthentication: PlatformLiveAuthenticationState | null | undefined,
): Promise<void> {
  const protection = liveAuthentication
    ? liveAuthentication.protection
    : state.secrets.authenticationSetupJson
      ? parsePlatformAuthenticationSetup(JSON.parse(state.secrets.authenticationSetupJson))
          .protection
      : null;
  if (!protection) {
    throw new Error(
      'platform: The active Access protection configuration is unavailable. Restore its database and encrypted setup checkpoint before maintenance.',
    );
  }
  dependencies.onProgress?.('Verifying current Access policies and protected origins');
  await (dependencies.verifyAccessProtection ?? verifyInstalledPlatformAccessProtection)({
    client: dependencies.client,
    manifest: state.manifest,
    plan: state.plan,
    dashboardUrl: platformDashboardUrl(state.plan.deployment),
    protection,
    checkpoint: secretCheckpoint(state.secrets, state.workerSecretUpdateIntent),
  });
}

function installationAccessCredentials(state: PlatformInstallRunState): string | undefined {
  if (!state.secrets.accessCredentialsJson) {
    return undefined;
  }
  const credentials: unknown = JSON.parse(state.secrets.accessCredentialsJson);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('platform: Invalid saved Access credentials.');
  }
  // Lifecycle HTTP calls use API/proxy origins. Retain optional dashboard credentials
  // in recovery storage without activating them, including after protection removal.
  const origins = [state.plan.apiUrl, state.plan.proxyUrl];
  return mergePlatformAccessCredentials(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(credentials).filter(([origin]) => origins.includes(origin)),
      ),
    ),
    origins,
  );
}

export async function preflightInstallationAuthentication(
  input: InstallationAuthenticationInput,
  lock: Pick<PlatformDatabaseLifecycleLock, 'readAuthenticationState'>,
): Promise<PlatformLiveAuthenticationState | null> {
  const liveAuthentication = (await lock.readAuthenticationState?.()) ?? null;
  // Use the same deployment decisions as preparation while keeping the current checkpoint.
  const preview = { ...input, state: { ...input.state } };
  applyInstallationAuthentication(preview, liveAuthentication);
  installationAccessCredentials(preview.state);
  checkpointAuthenticationResources(
    preview.state.manifest,
    preview.state.secrets,
    preview.state.manifest.updatedAt,
  );
  if (preview.state.plan.deployment.authentication.accessProtection) {
    await verifyInstallationAccessSetup(preview, liveAuthentication);
  }
  return liveAuthentication;
}

export async function prepareInstallationAuthentication(
  input: InstallationAuthenticationInput &
    Readonly<{
      releaseDatabaseLock: PlatformDatabaseLifecycleLock;
      now: () => string;
      checkedAuthentication?: PlatformLiveAuthenticationState | null;
    }>,
): Promise<void> {
  const { state, releaseDatabaseLock, runtime, now, dependencies, checkedAuthentication } = input;
  const { authenticationProtocolTransition } = input;
  const { workerSecretUpdateIntent } = state;
  const liveAuthentication =
    checkedAuthentication === undefined
      ? await releaseDatabaseLock.readAuthenticationState?.()
      : checkedAuthentication;
  applyInstallationAuthentication(input, liveAuthentication);
  const activateAccessCredentials = () => {
    const credentials = installationAccessCredentials(state);
    if (credentials !== undefined) {
      process.env.VOID_ACCESS_CREDENTIALS = credentials;
    }
  };
  activateAccessCredentials();
  state.manifest = checkpointAuthenticationResources(state.manifest, state.secrets, now());
  writeInstallationManifest(state.manifest);
  await releaseDatabaseLock.checkpoint?.(state.manifest);
  dependencies.onProgress?.('Checking and creating Cloudflare resources');
  if (
    !authenticationProtocolTransition &&
    JSON.stringify(state.manifest.deployment) !== JSON.stringify(state.plan.deployment)
  ) {
    state.manifest = {
      ...state.manifest,
      deployment: state.plan.deployment,
      updatedAt: now(),
    };
    writeInstallationManifest(state.manifest);
    await releaseDatabaseLock.checkpoint?.(state.manifest);
  }
  if (state.manifest.status !== 'provisioning') {
    state.manifest = transitionInstallation(state.manifest, 'provisioning', now());
    writeInstallationManifest(state.manifest);
  }
  if (
    runtime.deploymentExecution !== 1 &&
    (state.manifest.deploymentExecution === 1 ||
      dependencies.databaseRollbackSource?.manifest.deploymentExecution === 1)
  ) {
    // Admission takes a shared row lock on this authoritative checkpoint in the
    // transaction that creates its deployment job. This update closes admission
    // before the probe counts jobs, and before a Queue consumer can be removed.
    if (!releaseDatabaseLock.checkpoint) {
      throw new Error('platform: The database lifecycle lock cannot fence deployment admission.');
    }
    await releaseDatabaseLock.checkpoint(state.manifest);
    dependencies.onProgress?.('Verifying durable deployment operations have drained');
    await (dependencies.verifyDeploymentExecutionDrain ?? verifyPlatformDeploymentExecutionDrain)(
      state.plan.apiUrl,
      createPlatformHealthProbeToken(state.manifest.ownershipNonce),
      state.manifest.id,
    );
  }

  if (dependencies.prepareAuthentication) {
    dependencies.onProgress?.('Preparing platform authentication');
    try {
      state.secrets = {
        ...state.secrets,
        ...(await dependencies.prepareAuthentication(state.manifest, state.secrets)),
      };
    } catch (error) {
      // Preserve provider secrets/ambiguous-create intents written while the preparation
      // hook was running; the outer failure checkpoint must not erase that recovery data.
      const latest = readPendingInstallationSecrets(state.manifest) ?? {};
      state.secrets = {
        ...state.secrets,
        authenticationPreparation: Object.fromEntries(
          Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
        ),
        authenticationSetupJson:
          latest.authenticationSetupJson || state.secrets.authenticationSetupJson,
        authSetupToken: latest.authSetupToken || state.secrets.authSetupToken,
        authBootstrapCode: latest.authBootstrapCode || state.secrets.authBootstrapCode,
        accessProvisioningJson:
          latest.accessProvisioningJson || state.secrets.accessProvisioningJson,
        accessCredentialsJson: latest.accessCredentialsJson || state.secrets.accessCredentialsJson,
      };
      state.manifest = checkpointAuthenticationResources(state.manifest, state.secrets, now());
      writeInstallationManifest(state.manifest);
      await releaseDatabaseLock.checkpoint?.(state.manifest);
      throw error;
    }
    const latest = readPendingInstallationSecrets(state.manifest) ?? {};
    state.secrets = {
      ...state.secrets,
      authenticationPreparation: Object.fromEntries(
        Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
      ),
    };
    state.manifest = checkpointAuthenticationResources(state.manifest, state.secrets, now());
    writeInstallationManifest(state.manifest);
    await releaseDatabaseLock.checkpoint?.(state.manifest);
    activateAccessCredentials();
    assertRequiredPlatformSecrets(state.plan, state.manifest, state.secrets);
    if (
      state.secrets.authenticationSetupJson &&
      createHash('sha256')
        .update(state.secrets.authBootstrapCode ?? '')
        .digest('hex') !==
        parsePlatformAuthenticationSetup(JSON.parse(state.secrets.authenticationSetupJson))
          .bootstrapCredentialHash
    ) {
      throw new Error(
        'platform: Prepared authentication does not match its administrator setup code.',
      );
    }
    writePendingInstallationSecrets(state.manifest, {
      ...secretCheckpoint(state.secrets, workerSecretUpdateIntent),
      databaseClaimState: 'claimed',
    });
  }

  const appAccessSetupRequired =
    !!state.plan.deployment.appAccess &&
    !state.manifest.steps.some((step) => step.key === 'app-access-initialized:v1');
  if (appAccessSetupRequired) {
    if (dependencies.prepareAppAccess) {
      try {
        const appAccessSetupJson = await dependencies.prepareAppAccess(
          state.manifest,
          state.secrets,
        );
        const latest = readPendingInstallationSecrets(state.manifest) ?? {};
        state.secrets = {
          ...state.secrets,
          appAccessSetupJson,
          authenticationPreparation: Object.fromEntries(
            Object.entries(latest).filter(([key]) => isPlatformAuthenticationPreparationKey(key)),
          ),
        };
        writePendingInstallationSecrets(state.manifest, {
          ...secretCheckpoint(state.secrets, workerSecretUpdateIntent),
          databaseClaimState: 'claimed',
        });
      } catch (error) {
        const latest = readPendingInstallationSecrets(state.manifest) ?? {};
        state.secrets = {
          ...state.secrets,
          appAccessSetupJson: latest.appAccessSetupJson || state.secrets.appAccessSetupJson,
          authenticationPreparation: Object.fromEntries(
            Object.entries(latest).filter(([key]) => isPlatformAuthenticationPreparationKey(key)),
          ),
        };
        throw error;
      }
    }
    if (!state.secrets.appAccessSetupJson) {
      throw new Error(
        'platform: Restore the encrypted app access setup checkpoint before resuming.',
      );
    }
    if (!state.secrets.appAccessSetupToken) {
      if (
        state.manifest.resources.some(
          (resource) => resource.key === 'api-worker' && resource.state === 'ready',
        )
      ) {
        throw new Error(
          'platform: Restore the encrypted app access setup authority before resuming.',
        );
      }
      state.secrets = { ...state.secrets, appAccessSetupToken: randomBytes(32).toString('hex') };
      writePendingInstallationSecrets(state.manifest, {
        ...secretCheckpoint(state.secrets, workerSecretUpdateIntent),
        databaseClaimState: 'claimed',
      });
    }
  }
  if (
    checkedAuthentication === undefined &&
    state.plan.deployment.authentication.accessProtection
  ) {
    await verifyInstallationAccessSetup(input, liveAuthentication);
  }
  if (
    state.plan.deployment.authentication.accessProtection ||
    (appAccessSetupRequired &&
      state.secrets.appAccessSetupJson &&
      (JSON.parse(state.secrets.appAccessSetupJson) as { managed?: unknown }).managed === true)
  ) {
    dependencies.onProgress?.('Preparing Access for authenticated platform health checks');
    try {
      await (dependencies.prepareHealthAccess ?? ensurePlatformAccessHealthChecks)({
        client: dependencies.client,
        manifest: state.manifest,
        plan: state.plan,
        checkpoint: secretCheckpoint(state.secrets, workerSecretUpdateIntent),
        save: (accessHealthProvisioningJson) => {
          state.secrets = { ...state.secrets, accessHealthProvisioningJson };
          state.manifest = checkpointAuthenticationResources(state.manifest, state.secrets, now());
          writePendingInstallationSecrets(state.manifest, {
            ...secretCheckpoint(state.secrets, workerSecretUpdateIntent),
            databaseClaimState: 'claimed',
          });
          writeInstallationManifest(state.manifest);
        },
      });
    } catch (error) {
      if (
        appAccessSetupRequired &&
        state.secrets.appAccessSetupJson &&
        (JSON.parse(state.secrets.appAccessSetupJson) as { managed?: unknown }).managed &&
        error instanceof PlatformCloudflareApiError &&
        [401, 403].includes(error.status)
      ) {
        state.secrets = {
          ...state.secrets,
          authenticationPreparation: {
            ...state.secrets.authenticationPreparation,
            appAccessTokenRejected: 'true',
          },
        };
        writePendingInstallationSecrets(
          state.manifest,
          secretCheckpoint(state.secrets, workerSecretUpdateIntent),
        );
        throw new PlatformAppAccessCredentialError(
          'platform: App access token rejected while preparing health checks. Resume installation to provide a replacement.',
        );
      }
      throw error;
    } finally {
      await releaseDatabaseLock.checkpoint?.(state.manifest);
    }
  }
}
