import {
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  transitionInstallation,
} from '@void/platform';
import type { PlatformInstallationManifest, PlatformLifecycleOperation } from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { platformWorkerAction, platformWorkerDeployCallbacks } from './platform-install-workers.ts';
import { verifyPlatformHealth, bootstrapPlatformSharedEmail } from './platform-installer-health.ts';
import {
  requireId,
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
} from './platform-installer-resources.ts';
import {
  secretCheckpoint,
  createPlatformHealthProbeToken,
  platformWorkerSecretPayload,
} from './platform-installer-secrets.ts';
import type {
  InstallationCheckpointWriter,
  PlatformDatabaseLifecycleLock,
  PlatformInstallerDependencies,
  PlatformInstallationSecrets,
  PlatformInstallRunState,
  PlatformWorkerKey,
  PlatformHealthCheckContext,
} from './platform-installer-types.ts';
import {
  recordWorkerCutoverResolution,
  recordWorkerTrafficState,
  runPlatformWrangler,
  nextWorkerCutoverGeneration,
  recordWorkerSecretUpdateState,
  deployPlatformWorker,
  verifyPlatformWorkerCutoverVersions,
} from './platform-installer-workers.ts';
import { platformWorkersDevUrl } from './platform-plan.ts';
import type { PlatformInstallPlanAction } from './platform-plan.ts';
import { writeInstallationManifest, writePendingInstallationSecrets } from './platform-registry.ts';
import { platformManagedWorkerTraffic } from './platform-traffic.ts';

export async function enableInstallationServices(input: {
  readonly state: PlatformInstallRunState;
  readonly checkpointOperation: (phase: PlatformLifecycleOperation['phase']) => Promise<void>;
  readonly requiresStagedCommit: boolean;
  readonly authenticationCutoverCommitted: boolean;
  readonly now: () => string;
  readonly writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  readonly dependencies: PlatformInstallerDependencies;
  readonly workerKeys: ReadonlyArray<PlatformWorkerKey>;
  readonly workerActions: ReadonlyArray<PlatformInstallPlanAction>;
  readonly workerDeploymentSecrets: PlatformInstallationSecrets;
  readonly zoneId: string;
  readonly enabledConfigs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly configs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly cloudflareApiBaseUrl: string;
  readonly managedRoutes: ReturnType<typeof platformManagedWorkerTraffic>['routes'];
  readonly ids: { [k: string]: string };
  readonly runPinnedPlatformWrangler: typeof runPlatformWrangler;
  readonly shouldBootstrapSharedEmail: boolean;
  readonly releaseDatabaseLock: PlatformDatabaseLifecycleLock;
  readonly version: string;
  readonly targetUsageProtocolVersion: 0 | 1 | 2;
  readonly healthCheckContext: PlatformHealthCheckContext;
  readonly runtime: PlatformRuntimeManifest;
  readonly runtimeProvenance: NonNullable<PlatformInstallationManifest['runtime']>;
}): Promise<{ emailOperationId: string | undefined }> {
  const {
    state,
    checkpointOperation,
    requiresStagedCommit,
    authenticationCutoverCommitted,
    now,
    writeRemoteInstallationCheckpoint,
    dependencies,
    workerKeys,
    workerActions,
    workerDeploymentSecrets,
    zoneId,
    enabledConfigs,
    configs,
    cloudflareApiBaseUrl,
    managedRoutes,
    ids,
    runPinnedPlatformWrangler,
    shouldBootstrapSharedEmail,
    releaseDatabaseLock,
    version,
    targetUsageProtocolVersion,
    healthCheckContext,
    runtime,
    runtimeProvenance,
  } = input;
  const { plan, secrets } = state;

  await checkpointOperation('enabling');
  if (requiresStagedCommit) {
    if (!authenticationCutoverCommitted) {
      state.manifest = recordWorkerCutoverResolution(
        state.manifest,
        state.workerCutoverGeneration,
        'committed',
        now(),
      );
      state.manifest = recordWorkerTrafficState(
        state.manifest,
        state.workerCutoverGeneration,
        false,
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
      state.workerRollbacks = [];
    }

    state.workerCutoverGeneration = nextWorkerCutoverGeneration(state.manifest);
    if (state.workerSecretUpdateIntent) {
      state.manifest = recordWorkerSecretUpdateState(
        state.manifest,
        state.workerCutoverGeneration,
        'pending',
        state.workerSecretUpdateIntent.id,
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
      state.workerSecretUpdateIntent = {
        ...state.workerSecretUpdateIntent,
        generation: state.workerCutoverGeneration,
      };
      writePendingInstallationSecrets(
        state.manifest,
        secretCheckpoint(secrets, state.workerSecretUpdateIntent),
      );
    }
    const writeManifest = async (next: PlatformInstallationManifest): Promise<void> => {
      state.manifest = next;
      writeInstallationManifest(next);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, next);
    };
    for (const key of workerKeys) {
      dependencies.onProgress?.(`Enabling the ${key} service`);
      const action = platformWorkerAction(workerActions, key);
      const workerSecrets = platformWorkerSecretPayload(
        key,
        workerDeploymentSecrets,
        plan.account.id,
        zoneId,
        action.action !== 'create',
      );
      const preservedRoutes = dependencies.deployWorker
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
      const workerConfig = mergePlatformWorkerTrafficConfig(enabledConfigs[key], preservedRoutes);
      const previousWorkerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
      const rollback = dependencies.deployWorker
        ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
        : await deployPlatformWorker(workerConfig, workerSecrets, {
            ...platformWorkerDeployCallbacks({
              client: dependencies.client,
              plan,
              zoneId,
              ids,
              key,
              action,
              generation: state.workerCutoverGeneration,
              now,
              readManifest: () => state.manifest,
              writeManifest,
              checkpoint: (update) => update(),
            }),
            apiBaseUrl: cloudflareApiBaseUrl,
            managedRoutes: managedRoutes
              .filter((route) => route.script === action.name)
              .map((route) => route.pattern),
            preservedRoutes,
            previousConfig: previousWorkerConfig,
            previousPublicEndpoints: true,
            // Traffic opens only after every Worker in this generation is
            // verified against its own staged checkpoint, so none may be reused.
            reuseMatchingVersion: false,
            runner: runPinnedPlatformWrangler,
            workerExisted: true,
          });
      if (rollback) {
        state.workerRollbacks.push(rollback);
      }
    }
  }
  const verifyCurrentWorkerCutover = async () => {
    if (!requiresStagedCommit) {
      return;
    }
    if (dependencies.verifyWorkerCutover) {
      await dependencies.verifyWorkerCutover(state.manifest, state.workerCutoverGeneration);
    } else if (!dependencies.deployWorker) {
      await verifyPlatformWorkerCutoverVersions(
        state.manifest,
        state.workerCutoverGeneration,
        enabledConfigs,
        plan.account.id,
        runPinnedPlatformWrangler,
        workerKeys,
      );
    }
  };
  await verifyCurrentWorkerCutover();
  let emailOperationId: string | undefined;
  if (shouldBootstrapSharedEmail) {
    // Shared-zone setup mutates provider routing. Once it begins, retain the
    // verified Worker set and keep the installation's routing gate closed on
    // failure so a retry can resume the durable email operation safely.
    state.workerDeploymentCommitted = true;
    state.manifest = recordWorkerCutoverResolution(
      state.manifest,
      state.workerCutoverGeneration,
      'committed',
      now(),
    );
    if (state.workerSecretUpdateIntent) {
      state.manifest = recordWorkerSecretUpdateState(
        state.manifest,
        state.workerCutoverGeneration,
        'committed',
        state.workerSecretUpdateIntent.id,
        now(),
      );
    }
    writeInstallationManifest(state.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
    state.workerRollbacks = [];
    dependencies.onProgress?.('Preparing shared email routing');
    emailOperationId = await (dependencies.bootstrapEmail ?? bootstrapPlatformSharedEmail)(
      plan.apiUrl,
      createPlatformHealthProbeToken(state.manifest.ownershipNonce),
    );
  }
  // A failed uninstall, or one whose database is reused, leaves its record
  // behind. Remove it before traffic opens so Zero Trust writers run again.
  await releaseDatabaseLock.liftProjectZeroTrustFence?.();
  await dependencies.client.deleteKvValue(
    plan.account.id,
    requireId(ids, 'routing-kv'),
    PLATFORM_DISABLED_KEY,
  );
  if (requiresStagedCommit) {
    dependencies.onProgress?.('Verifying the enabled platform');
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(
      plan.apiUrl,
      state.manifest.id,
      plan.proxyUrl,
      plan.deployment.application.baseDomain,
      version,
      targetUsageProtocolVersion,
      createPlatformHealthProbeToken(state.manifest.ownershipNonce),
      undefined,
      !plan.deployment.application.zoneName
        ? platformWorkersDevUrl(plan, plan.deployment.resources.dispatchWorker)
        : undefined,
      healthCheckContext,
    );
    await verifyCurrentWorkerCutover();
  }
  state.workerDeploymentCommitted = true;
  state.manifest = recordWorkerCutoverResolution(
    state.manifest,
    state.workerCutoverGeneration,
    'committed',
    now(),
  );
  state.manifest = recordWorkerTrafficState(
    state.manifest,
    state.workerCutoverGeneration,
    true,
    now(),
  );
  if (state.workerSecretUpdateIntent) {
    state.manifest = recordWorkerSecretUpdateState(
      state.manifest,
      state.workerCutoverGeneration,
      'committed',
      state.workerSecretUpdateIntent.id,
      now(),
    );
  }
  state.manifest = {
    ...state.manifest,
    deployment: plan.deployment,
    deploymentExecution: runtime.deploymentExecution,
    platformVersion: version,
    runtime: runtimeProvenance,
    safetyProtocols: runtime.safetyProtocols,
    updatedAt: now(),
    usageProtocolVersion: targetUsageProtocolVersion,
  };
  state.manifest = transitionInstallation(state.manifest, 'installed', now());
  return { emailOperationId };
}
