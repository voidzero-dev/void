import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPlatformInstallationManifest,
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationStep,
  setInstallationEndpoints,
  platformDashboardUrl,
  transitionInstallation,
  type PlatformInstallationManifest,
  type PlatformLifecycleOperation,
} from '@void/platform';
import { PLATFORM_ADMIN_ASSETS_DIRECTORY, resolvePlatformRuntime } from '@void/platform/installer';
import { join } from 'pathslash';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { getErrorMessage } from './output.ts';
import {
  initializeInstalledAppAccess,
  PlatformAppAccessCredentialError,
} from './platform-app-access.ts';
import {
  initializeInstalledPlatformAuthentication,
  resumeInstalledPlatformAuthentication,
} from './platform-auth-bootstrap.ts';
import { verifyExternalPlatformHyperdrive } from './platform-auth-database.ts';
import { parsePostgresConnectionString } from './platform-cloudflare.ts';
import { enableInstallationServices } from './platform-install-activation.ts';
import { prepareInstallationAuthentication } from './platform-install-preparation.ts';
import { provisionInstallationServices } from './platform-install-provisioning.ts';
import { uploadInstallationWorkers } from './platform-install-workers.ts';
import { workerCutoverUpdatesSecrets } from './platform-installer-cutover.ts';
import {
  assertVoidCreatedHyperdriveTrustsDatabase,
  claimPlatformDatabase,
  assertPlatformRuntimeSafety,
} from './platform-installer-database.ts';
import { verifyPlatformHealth, verifyPlatformSandboxDrain } from './platform-installer-health.ts';
import {
  requireId,
  writeRemoteInstallationCheckpointWithoutDatabase,
  hash,
  saveInstalledPlatformConnection,
} from './platform-installer-resources.ts';
import { verifyRuntimeArtifacts } from './platform-installer-runtime.ts';
import {
  sanitizeWorkerSecretUpdates,
  assertRequiredPlatformSecrets,
  secretCheckpoint,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';
import {
  type PlatformInstallerDependencies,
  type PlatformWorkerRollback,
  type InstallationCheckpointWriter,
  PlatformWorkerRecoveryIncompleteError,
  type PlatformInstallationSecrets,
  type PlatformInstallationResult,
  type PlatformInstallRunState,
  type PlatformWorkerKey,
  type PlatformWorkerSecretUpdateIntent,
  type InstallerClient,
  type PlatformHealthCheckContext,
} from './platform-installer-types.ts';
import {
  recordWorkerCutoverResolution,
  recordWorkerTrafficState,
  runPlatformWrangler,
  runPlatformWranglerAtApiBase,
  stablePublicEndpointState,
  interruptedWorkerCutover,
  nextTrafficGeneration,
  recoverInterruptedPlatformWorkerCutover,
  nextWorkerCutoverGeneration,
  recordWorkerSecretUpdateState,
} from './platform-installer-workers.ts';
import {
  platformWorkersDevUrl,
  type PlatformInstallPlan,
  type PlatformInstallPlanAction,
} from './platform-plan.ts';
import {
  latestPlatformWorkerCutoverGeneration,
  platformWorkerSecretUpdateIntentState,
  promoteInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import { assertPlatformWorkerSecretUpdateAuthority } from './platform-secret-update-authority.ts';
import { platformManagedWorkerTraffic } from './platform-traffic.ts';

export { PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY as REMOTE_INSTALLATION_MANIFEST_KEY } from '@void/platform';

// Preserve the routing gate first; rollback and manifest failure checkpoints
// follow while the database lifecycle lock is still held by the caller.
async function recoverFailedPlatformInstallation(
  error: unknown,
  state: Readonly<{
    manifest: PlatformInstallationManifest;
    plan: PlatformInstallPlan;
    dependencies: PlatformInstallerDependencies;
    workerTrafficGuarded: boolean;
    workerDeploymentCommitted: boolean;
    workerRollbacks: Array<PlatformWorkerRollback>;
    workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null;
    authenticationEnforcementActive: boolean;
    authenticationProtocolTransition: boolean;
    workerCutoverGeneration: number;
    previousPublicEndpoints: boolean;
    operationStarted: boolean;
    now: () => string;
    writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  }>,
): Promise<unknown> {
  const {
    plan,
    dependencies,
    workerTrafficGuarded,
    workerDeploymentCommitted,
    workerRollbacks,
    authenticationEnforcementActive,
    authenticationProtocolTransition,
    workerCutoverGeneration,
    previousPublicEndpoints,
    operationStarted,
    now,
    writeRemoteInstallationCheckpoint,
  } = state;
  let { manifest } = state;
  let failure: unknown = error;
  const currentWorkerRecoveryIncomplete = error instanceof PlatformWorkerRecoveryIncompleteError;
  if (workerTrafficGuarded) {
    try {
      await dependencies.client.putKvValue(
        plan.account.id,
        requireId(
          Object.fromEntries(manifest.resources.map((resource) => [resource.key, resource.id])),
          'routing-kv',
        ),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
    } catch (guardError) {
      failure = new Error(
        `platform: ${getErrorMessage(error)} The installation also failed to retain its routing safety gate: ${getErrorMessage(guardError)}`,
        { cause: error },
      );
    }
  }
  // Rotated credentials cannot safely be rolled back to immutable versions
  // containing the old secrets. Keep traffic closed and roll forward on retry.
  // Authentication transitions likewise retain the compatible Worker set.
  if (
    !workerDeploymentCommitted &&
    workerRollbacks.length > 0 &&
    !state.workerSecretUpdateIntent &&
    !(authenticationEnforcementActive && authenticationProtocolTransition)
  ) {
    const rollbackFailures: Array<string> = [];
    for (const rollback of workerRollbacks.reverse()) {
      try {
        await rollback();
      } catch (rollbackError) {
        rollbackFailures.push(getErrorMessage(rollbackError));
      }
    }
    if (rollbackFailures.length > 0 || currentWorkerRecoveryIncomplete) {
      failure = new Error(
        rollbackFailures.length > 0
          ? `platform: ${getErrorMessage(error)} Automatic Worker rollback was incomplete: ${rollbackFailures.join('; ')} Inspect the installation before retrying.`
          : `platform: ${getErrorMessage(error)} The current Worker rollback was incomplete. The cutover remains unresolved and will be recovered on retry.`,
        { cause: error },
      );
    } else if (workerCutoverGeneration > 0) {
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'restored',
        now(),
      );
      manifest = recordWorkerTrafficState(
        manifest,
        workerCutoverGeneration,
        previousPublicEndpoints,
        now(),
      );
      writeInstallationManifest(manifest);
    }
  }
  if (manifest.status !== 'uninstalled' && (manifest.status !== 'failed' || operationStarted)) {
    try {
      const updatedAt = now();
      manifest = transitionInstallation(manifest, 'failed', updatedAt);
      if (operationStarted && manifest.operation) {
        manifest = {
          ...manifest,
          operation: { ...manifest.operation, phase: 'failed', updatedAt },
        };
      }
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    } catch {
      // Preserve the original failure when a terminal state cannot transition.
    }
  }
  return failure;
}

export async function installPlatform(
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  existing: PlatformInstallationManifest | null,
  dependencies: PlatformInstallerDependencies,
): Promise<PlatformInstallationResult> {
  if (plan.actions.some((action) => action.action === 'inspect')) {
    throw new Error(
      'platform: AI Gateway access must be verified before provisioning. Provide AI Gateway: Edit on the runtime token, then retry.',
    );
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const cloudflareApiBaseUrl = dependencies.client.apiBaseUrl;
  const pinnedPlatformWrangler =
    (parallelWorkerUpload: boolean): typeof runPlatformWrangler =>
    (operation, accountId, cwd, capture) =>
      runPlatformWranglerAtApiBase(
        operation,
        accountId,
        cwd,
        capture,
        cloudflareApiBaseUrl,
        parallelWorkerUpload,
        dependencies.operatorApiToken,
      );
  const runPinnedPlatformWrangler = pinnedPlatformWrangler(false);
  const runParallelPinnedPlatformWrangler = pinnedPlatformWrangler(true);
  const resolvedRuntime = dependencies.runtime ?? resolvePlatformRuntime();
  const runtimeDirectory = resolvedRuntime.directory;
  const runtime = resolvedRuntime.manifest;
  if (plan.deployment.appAccess && runtime.appAccessSetup !== 1) {
    throw new Error('platform: This runtime does not support the installation’s app access setup.');
  }
  const hasEmailGatewayArtifact = runtime.artifacts.emailGateway !== undefined;
  if (
    existing?.steps.some((step) => step.key === 'private-previews-initialized:v1') &&
    runtime.privatePreviews !== 1
  ) {
    throw new Error(
      'platform: This installation has private previews. Use a runtime with private preview support.',
    );
  }
  if (runtime.emailProtocolVersion !== 1 && plan.deployment.capabilities.email) {
    throw new Error(
      'platform: This runtime cannot serve enabled platform email without email protocol version 1.',
    );
  }
  if (
    runtime.emailProtocolVersion !== 1 &&
    existing?.resources.some(
      (resource) => resource.key === 'email-gateway-worker' && resource.state === 'ready',
    )
  ) {
    throw new Error(
      'platform: This runtime cannot replace an installed email gateway Worker. Use a runtime with email protocol version 1.',
    );
  }
  const workerKeys: ReadonlyArray<PlatformWorkerKey> = hasEmailGatewayArtifact
    ? ['api', 'proxy', 'emailGateway', 'tail', 'dispatch']
    : ['api', 'proxy', 'tail', 'dispatch'];
  if (plan.deployment.authentication.configurable && runtime.authenticationProtocolVersion !== 1) {
    throw new Error(
      'platform: This runtime does not support configurable authentication. Upgrade Void or use a compatible runtime.',
    );
  }
  if (plan.deployment.application.workersDev && runtime.applicationRoutingVersion !== 1) {
    throw new Error(
      'platform: This runtime does not support workers.dev application routing. Use a current platform runtime.',
    );
  }
  verifyRuntimeArtifacts(runtimeDirectory, runtime);
  const hyperdriveAction = plan.actions.find((action) => action.key === 'hyperdrive');
  const recordedHyperdrive = existing?.resources.find((resource) => resource.key === 'hyperdrive');
  let externalHyperdriveOriginHash: string | undefined;
  if (
    hyperdriveAction &&
    (hyperdriveAction.action === 'adopt' || recordedHyperdrive?.ownership === 'adopted')
  ) {
    if (!hyperdriveAction.id) {
      throw new Error('platform: The externally managed Hyperdrive has no ID.');
    }
    if (!plan.externalHyperdrive && !recordedHyperdrive) {
      throw new Error('platform: The externally managed Hyperdrive origin must be specified.');
    }
    const live = await dependencies.client.getHyperdriveConfig(
      plan.account.id,
      hyperdriveAction.id,
    );
    externalHyperdriveOriginHash = verifyExternalPlatformHyperdrive({
      config: live,
      databaseUrl: secrets.databaseUrl,
      expected: {
        id: hyperdriveAction.id,
        name: hyperdriveAction.name,
        host: plan.externalHyperdrive?.host ?? live.origin.host,
        user: plan.externalHyperdrive?.user ?? live.origin.user ?? '',
      },
      ...(recordedHyperdrive ? { recordedHash: recordedHyperdrive.configHash } : {}),
    });
  }
  const runtimeProvenance = {
    manifestSha256: resolvedRuntime.manifestSha256,
    source: resolvedRuntime.source,
    sourceRevision: runtime.sourceRevision,
  } as const;
  const version = runtime.platformVersion;
  const targetUsageProtocolVersion = runtime.usageProtocolVersion;
  const sourcePlatformVersion = existing?.platformVersion ?? null;
  const hadPriorWorkers =
    existing !== null &&
    (existing.resources.some(
      (resource) => resource.kind === 'worker' && resource.state === 'ready',
    ) ||
      plan.actions.some((action) => action.kind === 'worker' && action.action !== 'create'));
  const preserveDisabled = existing?.desiredState === 'disabled';
  const shouldBootstrapSharedEmail =
    !preserveDisabled &&
    plan.deployment.capabilities.email &&
    runtime.emailProtocolVersion === 1 &&
    !!plan.deployment.emailSharedZoneId;
  const previousPublicEndpoints = stablePublicEndpointState(existing);
  const authenticationProtocolTransition =
    hadPriorWorkers &&
    existing?.deployment.authentication.configurable !== true &&
    runtime.authenticationProtocolVersion === 1;
  let workerTrafficGuarded = false;
  let manifest: PlatformInstallationManifest;
  if (!existing) {
    const createdAt = now();
    manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt,
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: randomBytes(32).toString('base64url'),
      platformVersion: version,
    });
    manifest = transitionInstallation(manifest, 'planned', now());
    writeInstallationManifest(manifest);
  } else if (existing.status === 'uninstalled') {
    throw new Error(`platform: Installation ${existing.id} has already been uninstalled.`);
  } else {
    manifest = existing;
  }
  const explicitWorkerSecretUpdates = sanitizeWorkerSecretUpdates(secrets.workerSecretUpdates);
  const hasExplicitWorkerSecretUpdates = Object.keys(explicitWorkerSecretUpdates).length > 0;
  const resumedWorkerSecretUpdateIntent =
    secrets.pendingWorkerSecretUpdateIntent &&
    platformWorkerSecretUpdateIntentState(manifest, secrets.pendingWorkerSecretUpdateIntent) ===
      'active'
      ? secrets.pendingWorkerSecretUpdateIntent
      : null;
  const workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null =
    hasExplicitWorkerSecretUpdates
      ? {
          // Keep the recovery authority until the next generation is durably
          // staged, including a crash after resolving the previous cutover.
          baselineGeneration:
            resumedWorkerSecretUpdateIntent?.baselineGeneration ??
            latestPlatformWorkerCutoverGeneration(manifest),
          generation: resumedWorkerSecretUpdateIntent?.generation ?? null,
          id: resumedWorkerSecretUpdateIntent?.id ?? randomUUID(),
          schema: 1,
          updates: {
            ...resumedWorkerSecretUpdateIntent?.updates,
            ...explicitWorkerSecretUpdates,
          },
        }
      : resumedWorkerSecretUpdateIntent;
  assertRequiredPlatformSecrets(plan, manifest, secrets, !!dependencies.prepareAuthentication);
  if (hyperdriveAction?.action === 'create') {
    // Reject a URL Hyperdrive can never accept before the claim binds it to this installation.
    parsePostgresConnectionString(secrets.databaseUrl);
    assertVoidCreatedHyperdriveTrustsDatabase(secrets.databaseUrl);
  }
  if (plan.externalHyperdrive) {
    secrets = { ...secrets, externalHyperdriveJson: JSON.stringify(plan.externalHyperdrive) };
  }
  // The phases update this state in place, and failure recovery reads its latest values.
  const state: PlatformInstallRunState = {
    manifest,
    plan,
    secrets,
    workerSecretUpdateIntent,
    workerCutoverGeneration: 0,
    workerRollbacks: [],
    workerDeploymentCommitted: false,
    authenticationEnforcementActive: false,
  };
  const pendingSecrets = secretCheckpoint(state.secrets, state.workerSecretUpdateIntent);
  writePendingInstallationSecrets(state.manifest, {
    ...pendingSecrets,
    databaseClaimState: 'claiming',
  });

  dependencies.onProgress?.('Preparing the platform database');
  try {
    await (dependencies.claimDatabase ?? claimPlatformDatabase)(
      state.secrets.databaseUrl,
      state.manifest.id,
      state.manifest.ownershipNonce,
    );
  } catch (error) {
    writePendingInstallationSecrets(state.manifest, {
      ...pendingSecrets,
      databaseClaimState: 'failed',
    });
    throw error;
  }
  writePendingInstallationSecrets(state.manifest, {
    ...pendingSecrets,
    databaseClaimState: 'claimed',
  });
  dependencies.onProgress?.('Acquiring the database lock');
  const releaseDatabaseLock = await dependencies.acquireDatabaseLifecycleLock(
    state.secrets.databaseUrl,
    state.manifest.id,
    state.manifest.ownershipNonce,
  );
  const writeRemoteInstallationCheckpoint = (
    client: InstallerClient,
    checkpointPlan: PlatformInstallPlan,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteInstallationCheckpointWithoutDatabase(
      client,
      checkpointPlan,
      checkpointManifest,
      releaseDatabaseLock,
    );
  const authoritative = releaseDatabaseLock.authoritativeManifest;
  if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(state.manifest)) {
    writeInstallationManifest(authoritative);
    await releaseDatabaseLock();
    throw new Error(
      'platform: This installation changed on another host. Local state was refreshed; rerun the command to review a current plan.',
    );
  }
  try {
    assertPlatformWorkerSecretUpdateAuthority({
      explicitUpdates: explicitWorkerSecretUpdates,
      localIntent: state.secrets.pendingWorkerSecretUpdateIntent,
      manifest: state.manifest,
      requiresEmailSigningSecret:
        state.manifest.deployment.capabilities.email || state.plan.deployment.capabilities.email,
    });
  } catch (error) {
    await releaseDatabaseLock();
    throw error;
  }
  // Progress is checkpointed under the same lifecycle lock as mutations. Do not
  // update it from parallel Worker upload callbacks.
  const checkpointOperation = async (phase: PlatformLifecycleOperation['phase']) => {
    if (!state.manifest.operation) {
      return;
    }
    const updatedAt = now();
    state.manifest = {
      ...state.manifest,
      operation: { ...state.manifest.operation, phase, updatedAt },
      updatedAt,
    };
    writeInstallationManifest(state.manifest);
    await releaseDatabaseLock.checkpoint?.(state.manifest);
  };
  let operationStarted = false;
  try {
    assertPlatformRuntimeSafety(
      runtime,
      state.manifest.safetyProtocols,
      releaseDatabaseLock.requiredSafetyProtocols,
    );
    if (existing) {
      await dependencies.verifyExistingOwnership?.(
        state.manifest,
        authoritative !== null && authoritative !== undefined,
      );
    }
    const action = dependencies.operation ?? (existing ? 'upgrade' : 'install');
    const previousOperation = state.manifest.operation;
    const resuming =
      previousOperation?.action === action &&
      previousOperation.toVersion === version &&
      previousOperation.runtimeManifestSha256 === resolvedRuntime.manifestSha256 &&
      previousOperation.phase !== 'complete';
    const startedAt = now();
    operationStarted = true;
    state.manifest = {
      ...state.manifest,
      operation: {
        id: resuming ? previousOperation.id : randomUUID(),
        action,
        fromVersion: resuming ? previousOperation.fromVersion : sourcePlatformVersion,
        toVersion: version,
        runtimeManifestSha256: resolvedRuntime.manifestSha256,
        phase: 'preparing',
        startedAt: resuming ? previousOperation.startedAt : startedAt,
        updatedAt: startedAt,
      },
      updatedAt: startedAt,
    };
    await checkpointOperation('preparing');
    await prepareInstallationAuthentication({
      state,
      releaseDatabaseLock,
      runtime,
      authenticationProtocolTransition,
      now,
      dependencies,
    });

    // Establish the durable installation checkpoint before creating any
    // resource that may need to be reconciled or removed after interruption.
    const provisioned = await provisionInstallationServices({
      state,
      now,
      releaseDatabaseLock,
      dependencies,
      writeRemoteInstallationCheckpoint,
      checkpointOperation,
      externalHyperdriveOriginHash,
      runtime,
      runtimeDirectory,
      sourcePlatformVersion,
      hadPriorWorkers,
    });
    if ('waitingForDns' in provisioned) {
      return provisioned;
    }
    const {
      zone,
      zoneId,
      targetSandboxDrainProtocol,
      prepareSandboxDrain,
      sandboxDrainState,
      ids,
      entrypoints,
    } = provisioned;
    let interruptedCutover = interruptedWorkerCutover(state.manifest);
    if (
      interruptedCutover &&
      authenticationProtocolTransition &&
      state.authenticationEnforcementActive
    ) {
      state.manifest = recordWorkerCutoverResolution(
        state.manifest,
        interruptedCutover.generation,
        'committed',
        now(),
      );
      state.manifest = recordWorkerTrafficState(
        state.manifest,
        interruptedCutover.generation,
        false,
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
      interruptedCutover = null;
    }
    const recoveringUnsafeTraffic = (interruptedCutover?.unsafeTraffic.size ?? 0) > 0;
    const createsWorker = state.plan.actions.some(
      (action) =>
        action.kind === 'worker' &&
        action.action === 'create' &&
        (hasEmailGatewayArtifact || action.key !== 'email-gateway-worker'),
    );
    const recoveringCreatedWorker =
      interruptedCutover !== null &&
      [...interruptedCutover.staged.values()].some(
        (snapshot) => snapshot.previousVersionId === null,
      );
    const requiresSandboxDrain =
      !preserveDisabled && targetSandboxDrainProtocol >= 1 && sandboxDrainState === 'pending';
    const requiresTrafficGuard =
      !previousPublicEndpoints ||
      (hadPriorWorkers && !!state.workerSecretUpdateIntent) ||
      (!!interruptedCutover &&
        workerCutoverUpdatesSecrets(state.manifest, interruptedCutover.generation)) ||
      recoveringUnsafeTraffic ||
      createsWorker ||
      recoveringCreatedWorker ||
      state.manifest.usageProtocolVersion !== targetUsageProtocolVersion ||
      (runtime.privatePreviews === 1 &&
        !state.manifest.steps.some((step) => step.key === 'private-previews-initialized:v1')) ||
      authenticationProtocolTransition ||
      shouldBootstrapSharedEmail ||
      requiresSandboxDrain ||
      (!!state.plan.deployment.appAccess &&
        !state.manifest.steps.some((step) => step.key === 'app-access-initialized:v1'));
    const configInput = {
      authenticationDatabaseUncached: true,
      proxyHealthBinding: true,
      accountId: state.plan.account.id,
      apiUrl: state.plan.apiUrl,
      deployment: state.plan.deployment,
      deploymentExecution: runtime.deploymentExecution,
      healthProbeToken: createPlatformHealthProbeToken(state.manifest.ownershipNonce),
      installationId: state.manifest.id,
      ownershipNonce: state.manifest.ownershipNonce,
      platformVersion: version,
      proxyUrl: state.plan.proxyUrl,
      emailGatewayUrl: platformWorkersDevUrl(
        state.plan,
        state.plan.deployment.resources.emailGatewayWorker,
      ),
      resources: {
        hyperdrive: requireId(ids, 'hyperdrive'),
        isrCacheKv: requireId(ids, 'isr-cache-kv'),
        legacyAssetsKv: requireId(ids, 'legacy-assets-kv'),
        routingKv: requireId(ids, 'routing-kv'),
        zone: zoneId,
      },
      runtimeEntrypoints: entrypoints as Record<PlatformWorkerKey, string>,
      ...(runtime.assets
        ? {
            runtimeApiAssetsDirectory: join(runtimeDirectory, PLATFORM_ADMIN_ASSETS_DIRECTORY),
          }
        : {}),
    };
    const enabledConfigs = createPlatformWorkerConfigs({
      ...configInput,
      privatePreviews: runtime.privatePreviews === 1,
      publicEndpoints: !preserveDisabled,
      trafficState: preserveDisabled ? 'staging' : 'enabled',
    });
    // The Cloudflare CLI asks the operator before it replaces changes made
    // outside Void. Let it ask now: the resources that these configs use
    // exist, and this run has not paused traffic or deployed a Worker.
    const outsideChangeConfigs = workerKeys
      .map((key) => enabledConfigs[key])
      .filter((config) => dependencies.replaceOutsideChanges?.includes(String(config.name)));
    if (outsideChangeConfigs.length > 0) {
      await dependencies.uploadOutsideChanges?.(outsideChangeConfigs);
    }
    if (requiresTrafficGuard) {
      await dependencies.client.putKvValue(
        state.plan.account.id,
        requireId(ids, 'routing-kv'),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
      workerTrafficGuarded = true;
      dependencies.onProgress?.('Application traffic paused for a safe platform cutover');
    }
    if (!preserveDisabled) {
      const trafficGeneration = nextTrafficGeneration(state.manifest);
      state.manifest = recordInstallationStep(
        state.manifest,
        {
          completedAt: now(),
          key: `traffic-enabled:${trafficGeneration}`,
          resultHash: String(trafficGeneration),
        },
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
    }
    // Preparation can generate new setup credentials. Snapshot only after all
    // preparation has completed so the deployed API can verify the handoff.
    const workerDeploymentSecrets: PlatformInstallationSecrets = {
      ...state.secrets,
      workerSecretUpdates: state.workerSecretUpdateIntent?.updates ?? {},
    };
    const requiresStagedCommit = !preserveDisabled && requiresTrafficGuard;
    const configs = requiresStagedCommit
      ? createPlatformWorkerConfigs({
          ...configInput,
          privatePreviews: runtime.privatePreviews === 1,
          publicEndpoints: true,
          trafficState: requiresSandboxDrain ? 'sandbox-drain' : 'staging',
        })
      : enabledConfigs;
    const previousConfigs = createPlatformWorkerConfigs({
      ...configInput,
      privatePreviews: existing?.steps.some(
        (step) => step.key === 'private-previews-initialized:v1',
      ),
      publicEndpoints: previousPublicEndpoints,
      trafficState: previousPublicEndpoints ? 'enabled' : 'staging',
    });
    const managedRoutes = platformManagedWorkerTraffic(state.plan.deployment).routes;
    let workerActions: ReadonlyArray<PlatformInstallPlanAction> = state.plan.actions.filter(
      (action) =>
        action.kind === 'worker' &&
        (hasEmailGatewayArtifact || action.key !== 'email-gateway-worker'),
    );
    ({ manifest: state.manifest, workerActions } = await recoverInterruptedPlatformWorkerCutover({
      manifest: state.manifest,
      interruptedCutover,
      workerActions,
      configs,
      previousConfigs,
      plan: state.plan,
      dependencies,
      ids,
      previousPublicEndpoints,
      hasEmailGatewayArtifact,
      runPinnedPlatformWrangler,
      now,
      writeRemoteInstallationCheckpoint,
      onManifestChange: (next) => {
        state.manifest = next;
      },
    }));
    state.workerCutoverGeneration = nextWorkerCutoverGeneration(state.manifest);
    if (state.workerSecretUpdateIntent) {
      // Keep this authorized intent resumable on either side of the next
      // manifest checkpoint before binding it to the new generation.
      state.workerSecretUpdateIntent = { ...state.workerSecretUpdateIntent, generation: null };
      writePendingInstallationSecrets(
        state.manifest,
        secretCheckpoint(state.secrets, state.workerSecretUpdateIntent),
      );
      state.manifest = recordWorkerSecretUpdateState(
        state.manifest,
        state.workerCutoverGeneration,
        'pending',
        state.workerSecretUpdateIntent.id,
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
      state.workerSecretUpdateIntent = {
        ...state.workerSecretUpdateIntent,
        generation: state.workerCutoverGeneration,
      };
      writePendingInstallationSecrets(
        state.manifest,
        secretCheckpoint(state.secrets, state.workerSecretUpdateIntent),
      );
    }
    await uploadInstallationWorkers({
      state,
      dependencies,
      requiresStagedCommit,
      recoveringUnsafeTraffic,
      workerActions,
      workerKeys,
      workerDeploymentSecrets,
      zoneId,
      now,
      writeRemoteInstallationCheckpoint,
      configs,
      previousConfigs,
      cloudflareApiBaseUrl,
      preserveDisabled,
      managedRoutes,
      previousPublicEndpoints,
      ids,
      runParallelPinnedPlatformWrangler,
      runPinnedPlatformWrangler,
    });

    state.manifest = setInstallationEndpoints(
      state.manifest,
      {
        apiUrl: state.plan.apiUrl,
        dashboardUrl: platformDashboardUrl(state.plan.deployment),
        proxyUrl: state.plan.proxyUrl,
      },
      now(),
    );
    if (preserveDisabled) {
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
        false,
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
        deployment: state.plan.deployment,
        deploymentExecution: runtime.deploymentExecution,
        platformVersion: version,
        runtime: runtimeProvenance,
        updatedAt: now(),
        usageProtocolVersion: targetUsageProtocolVersion,
      };
      state.manifest = transitionInstallation(state.manifest, 'disabled', now());
      await checkpointOperation('complete');
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
      writePendingInstallationSecrets(state.manifest, secretCheckpoint(state.secrets));
      promoteInstallationSecrets(state.manifest);
      saveInstalledPlatformConnection(state.plan, state.manifest);
      return {
        manifest: state.manifest,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: zone?.nameServers ?? [],
      };
    }
    let authenticationCutoverCommitted = false;
    if (authenticationProtocolTransition && requiresStagedCommit) {
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
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
      // From this point onward the database may enforce revocable sessions. Retain the
      // compatible maintenance runtime on failure instead of restoring incapable Workers.
      state.workerRollbacks = [];
      authenticationCutoverCommitted = true;
    }
    let authenticationStep = state.secrets.authenticationSetupJson
      ? 'authentication-initialized:v1:' + hash(state.secrets.authenticationSetupJson)
      : '';
    let setupPending = false;
    state.manifest = transitionInstallation(state.manifest, 'verifying', now());
    await checkpointOperation('verifying');
    writeInstallationManifest(state.manifest);
    if (state.plan.deployment.authentication.configurable && authenticationStep) {
      if (!state.secrets.authenticationSetupJson || !state.secrets.authSetupToken) {
        throw new Error(
          'platform: Restore the encrypted authentication setup checkpoint before resuming.',
        );
      }
      dependencies.onProgress?.('Initializing platform authentication');
      const authentication = await resumeInstalledPlatformAuthentication(
        {
          apiUrl: state.plan.apiUrl,
          installationId: state.manifest.id,
          setupToken: state.secrets.authSetupToken,
          setupJson: state.secrets.authenticationSetupJson,
          checkpoint: (replacement) => {
            state.secrets = { ...state.secrets, ...replacement };
            authenticationStep =
              'authentication-initialized:v1:' + hash(replacement.authenticationSetupJson);
            writePendingInstallationSecrets(
              state.manifest,
              secretCheckpoint(state.secrets, state.workerSecretUpdateIntent),
            );
          },
        },
        dependencies.initializeAuthentication ?? initializeInstalledPlatformAuthentication,
      );
      if (authentication.setupPending) {
        setupPending = true;
        dependencies.onProgress?.(
          'Administrator setup prepared; its link and code are shown when this finishes',
        );
      }
      state.manifest = recordInstallationStep(
        state.manifest,
        {
          key: authenticationStep,
          completedAt: now(),
          resultHash: hash(state.secrets.authenticationSetupJson),
        },
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
    }
    if (
      state.plan.deployment.appAccess &&
      !state.manifest.steps.some((step) => step.key === 'app-access-initialized:v1')
    ) {
      dependencies.onProgress?.('Configuring and verifying deployed-app access');
      try {
        await (dependencies.initializeAppAccess ?? initializeInstalledAppAccess)({
          apiUrl: state.plan.apiUrl,
          installationId: state.manifest.id,
          probeToken: createPlatformHealthProbeToken(state.manifest.ownershipNonce),
          setupJson: state.secrets.appAccessSetupJson!,
          setupToken: state.secrets.appAccessSetupToken!,
        });
      } catch (error) {
        if (error instanceof PlatformAppAccessCredentialError) {
          state.secrets = {
            ...state.secrets,
            authenticationPreparation: {
              ...state.secrets.authenticationPreparation,
              appAccessTokenRejected: 'true',
            },
          };
          writePendingInstallationSecrets(
            state.manifest,
            secretCheckpoint(state.secrets, state.workerSecretUpdateIntent),
          );
        }
        throw error;
      }
      state.manifest = recordInstallationStep(
        state.manifest,
        {
          key: 'app-access-initialized:v1',
          completedAt: now(),
          resultHash: hash(state.secrets.appAccessSetupJson!),
        },
        now(),
      );
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
    }
    dependencies.onProgress?.('Verifying platform health');
    const emailGatewayUrl =
      hasEmailGatewayArtifact && state.plan.deployment.capabilities.email
        ? platformWorkersDevUrl(state.plan, state.plan.deployment.resources.emailGatewayWorker)
        : undefined;
    if (state.plan.deployment.authentication.accessProtection) {
      ensurePlatformAccessToken(state.plan.apiUrl, false, true);
      ensurePlatformAccessToken(state.plan.proxyUrl, false, true);
    }
    const healthCheckContext: PlatformHealthCheckContext = {
      accountName: state.plan.account.name,
      ...(state.plan.deployment.authentication.accessProtection ? { accessProtected: true } : {}),
      workers: [
        state.plan.deployment.resources.apiWorker,
        state.plan.deployment.resources.proxyWorker,
        ...(emailGatewayUrl ? [state.plan.deployment.resources.emailGatewayWorker] : []),
        state.plan.deployment.resources.dispatchWorker,
      ],
      resumeCommand: dependencies.healthCheckResumeCommand,
      ...(emailGatewayUrl ? { emailGatewayUrl } : {}),
    };
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(
      state.plan.apiUrl,
      state.manifest.id,
      state.plan.proxyUrl,
      state.plan.deployment.application.baseDomain,
      version,
      targetUsageProtocolVersion,
      createPlatformHealthProbeToken(state.manifest.ownershipNonce),
      undefined,
      !state.plan.deployment.application.zoneName
        ? platformWorkersDevUrl(state.plan, state.plan.deployment.resources.dispatchWorker)
        : undefined,
      healthCheckContext,
    );
    if (requiresSandboxDrain) {
      const drainComplete = await (dependencies.verifySandboxDrain ?? verifyPlatformSandboxDrain)(
        state.plan.apiUrl,
        createPlatformHealthProbeToken(state.manifest.ownershipNonce),
      );
      if (!drainComplete) {
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
        state.manifest = recordInstallationStep(
          state.manifest,
          {
            completedAt: now(),
            key: 'sandbox-drain:maintenance-runtime:v1',
            resultHash: resolvedRuntime.manifestSha256,
          },
          now(),
        );
        await checkpointOperation('waiting-for-sandbox-drain');
        writeInstallationManifest(state.manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
        state.workerRollbacks = [];
        state.workerDeploymentCommitted = true;
        saveInstalledPlatformConnection(state.plan, state.manifest);
        return {
          manifest: state.manifest,
          waitingForDns: false,
          waitingForSandboxDrain: true,
          zoneNameServers: zone?.nameServers ?? [],
        };
      }
      const completedDrain = await prepareSandboxDrain!();
      if (completedDrain.state !== 'complete') {
        throw new Error(
          'platform: Sandbox drain completion changed while it was being verified. Traffic remains disabled.',
        );
      }
    }
    const enableInstallationServicesResult = await enableInstallationServices({
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
    });
    const emailOperationId = enableInstallationServicesResult.emailOperationId;
    if (runtime.privatePreviews === 1) {
      state.manifest = recordInstallationStep(
        state.manifest,
        {
          key: 'private-previews-initialized:v1',
          completedAt: now(),
          resultHash: hash('private-previews:v1'),
        },
        now(),
      );
    }
    await checkpointOperation('complete');
    writeInstallationManifest(state.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, state.plan, state.manifest);
    workerTrafficGuarded = false;
    writePendingInstallationSecrets(state.manifest, secretCheckpoint(state.secrets));
    promoteInstallationSecrets(state.manifest);
    saveInstalledPlatformConnection(state.plan, state.manifest);
    return {
      manifest: state.manifest,
      ...(emailOperationId ? { emailOperationId } : {}),
      setupPending,
      waitingForDns: false,
      waitingForSandboxDrain: false,
      zoneNameServers: zone?.nameServers ?? [],
    };
  } catch (error) {
    throw await recoverFailedPlatformInstallation(error, {
      ...state,
      dependencies,
      workerTrafficGuarded,
      authenticationProtocolTransition,
      previousPublicEndpoints,
      operationStarted,
      now,
      writeRemoteInstallationCheckpoint,
    });
  } finally {
    await releaseDatabaseLock();
  }
}

export { type PlatformDatabaseLifecycleLock } from './platform-installer-types.ts';

export {
  createPlatformInstallationSecrets,
  resolveBootstrapGitHubId,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';

export { recordResource } from './platform-installer-resources.ts';

export {
  platformDatabaseClientUrl,
  acquirePlatformDatabaseLifecycleLock,
  claimPlatformDatabase,
  acquirePlatformDatabaseLifecycleLockConnection,
  readPlatformDatabaseLifecycleManifest,
  readPlatformProjectSlugs,
  readPlatformProjectZeroTrustState,
} from './platform-installer-database.ts';

export { loadPlatformRuntime } from './platform-installer-runtime.ts';

export { PlatformAccessBlockedError } from './platform-installer-health.ts';
