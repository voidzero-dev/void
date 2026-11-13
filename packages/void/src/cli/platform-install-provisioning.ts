import {
  recordInstallationStep,
  transitionInstallation,
  type PlatformLifecycleOperation,
} from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { join } from 'pathslash';
import { publishInstallationAiLogging } from './platform-ai-logging-projection.ts';
import { verifyPlatformAuthenticationDatabase } from './platform-auth-database.ts';
import { preparePlatformDatabaseSchema } from './platform-installer-database.ts';
import {
  requireId,
  recordResource,
  recordProvisionIntent,
  createResource,
  recordAdoptionIntent,
  hasProvisionIntent,
  reconcilePlatformInstallationResources,
  hash,
} from './platform-installer-resources.ts';
import {
  type InstallationCheckpointWriter,
  type PlatformDatabaseLifecycleLock,
  type PlatformInstallerDependencies,
  type PlatformInstallationResult,
  type PlatformInstallRunState,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';

export async function provisionInstallationServices(input: {
  readonly state: PlatformInstallRunState;
  readonly now: () => string;
  readonly releaseDatabaseLock: PlatformDatabaseLifecycleLock;
  readonly dependencies: PlatformInstallerDependencies;
  readonly writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  readonly checkpointOperation: (phase: PlatformLifecycleOperation['phase']) => Promise<void>;
  readonly externalHyperdriveOriginHash: string | undefined;
  readonly runtime: PlatformRuntimeManifest;
  readonly runtimeDirectory: string;
  readonly sourcePlatformVersion: string | null;
  readonly hadPriorWorkers: boolean;
}): Promise<
  | PlatformInstallationResult
  | {
      zone: PlatformInstallPlan['zone'];
      zoneId: string;
      targetSandboxDrainProtocol: 0 | 1 | 2 | 3;
      prepareSandboxDrain: PlatformInstallerDependencies['prepareSandboxDrain'];
      sandboxDrainState: 'complete' | 'pending';
      ids: { [k: string]: string };
      entrypoints: Record<'api' | 'dispatch' | 'proxy' | 'tail', string> &
        Partial<Record<'emailGateway', string>>;
    }
> {
  const {
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
  } = input;
  const { plan, secrets } = state;

  const routingAction = plan.actions.find((action) => action.key === 'routing-kv')!;
  if (routingAction.action === 'adopt') {
    throw new Error('platform: The routing checkpoint cannot be adopted.');
  }
  if (routingAction.action === 'reuse') {
    if (
      !state.manifest.resources.some((resource) => resource.key === routingAction.key) &&
      routingAction.id
    ) {
      state.manifest = recordResource(
        state.manifest,
        routingAction,
        routingAction.id,
        'created',
        now(),
      );
      writeInstallationManifest(state.manifest);
    }
  } else {
    state.manifest = recordProvisionIntent(state.manifest, routingAction, now());
    writeInstallationManifest(state.manifest);
    await releaseDatabaseLock.checkpoint?.(state.manifest);
    const routing = await createResource(
      dependencies.client,
      plan,
      routingAction,
      secrets.databaseUrl,
      '',
    );
    state.manifest = recordResource(state.manifest, routingAction, routing.id, 'created', now());
    writeInstallationManifest(state.manifest);
  }
  await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);

  const zoneAction = plan.actions.find((action) => action.key === 'zone');
  let zone = plan.zone;
  if (zoneAction) {
    if (zoneAction.action === 'create') {
      state.manifest = recordProvisionIntent(state.manifest, zoneAction, now());
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
      zone = await dependencies.client.createZone(plan.account.id, zoneAction.name);
    }
    if (!zone) {
      throw new Error('platform: Cloudflare did not return the platform zone.');
    }
    if (zoneAction.action === 'adopt') {
      state.manifest = recordAdoptionIntent(state.manifest, zoneAction, zone.id, now());
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
    }
    state.manifest = recordResource(
      state.manifest,
      zoneAction,
      zone.id,
      zoneAction.action === 'adopt'
        ? 'adopted'
        : zoneAction.action === 'create' || hasProvisionIntent(state.manifest, zoneAction)
          ? 'created'
          : undefined,
      now(),
    );
    writeInstallationManifest(state.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
    if (zone.status !== 'active') {
      state.manifest = transitionInstallation(state.manifest, 'waiting-for-dns', now());
      await checkpointOperation('waiting-for-dns');
      writeInstallationManifest(state.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
      return {
        manifest: state.manifest,
        waitingForDns: true,
        waitingForSandboxDrain: false,
        zoneNameServers: zone.nameServers,
      };
    }
  }
  const zoneId = zone?.id ?? '';
  state.manifest = await reconcilePlatformInstallationResources(
    state.manifest,
    plan,
    secrets,
    zoneId,
    externalHyperdriveOriginHash,
    dependencies,
    now,
    writeRemoteInstallationCheckpoint,
    (next) => {
      state.manifest = next;
    },
  );

  dependencies.onProgress?.('Verifying uncached authentication database reads');
  const authenticationDatabase = state.manifest.resources.find(
    (resource) => resource.key === 'hyperdrive',
  );
  if (!authenticationDatabase) {
    throw new Error('platform: The authentication database resource is missing.');
  }
  await verifyPlatformAuthenticationDatabase(
    dependencies.client,
    plan.account.id,
    authenticationDatabase,
    secrets.databaseUrl,
  );

  state.manifest = await preparePlatformDatabaseSchema(
    state.manifest,
    runtime,
    runtimeDirectory,
    sourcePlatformVersion,
    hadPriorWorkers,
    plan,
    dependencies,
    releaseDatabaseLock,
    now,
    writeRemoteInstallationCheckpoint,
    (next) => {
      state.manifest = next;
    },
  );

  // First pass: the new proxy reads only ROUTING KV and may go live before the new API.
  await publishInstallationAiLogging({
    client: dependencies.client,
    accountId: plan.account.id,
    routingKvId: requireId(
      Object.fromEntries(state.manifest.resources.map((resource) => [resource.key, resource.id])),
      'routing-kv',
    ),
    databaseLock: releaseDatabaseLock,
    onProgress: dependencies.onProgress,
  });

  dependencies.onProgress?.('Checking platform safety');
  const targetSandboxDrainProtocol = runtime.safetyProtocols.sandboxDrain;
  const prepareSandboxDrain =
    dependencies.prepareSandboxDrain ?? releaseDatabaseLock.prepareSandboxDrain;
  if (targetSandboxDrainProtocol >= 1 && !prepareSandboxDrain) {
    throw new Error(
      'platform: The PostgreSQL lifecycle lock cannot establish the sandbox-drain safety checkpoint.',
    );
  }
  const sandboxDrainPreparation =
    targetSandboxDrainProtocol >= 1
      ? await prepareSandboxDrain!(
          targetSandboxDrainProtocol >= 3 ? 3 : targetSandboxDrainProtocol >= 2 ? 2 : 0,
        )
      : null;
  if (
    sandboxDrainPreparation &&
    sandboxDrainPreparation.admissionProtocol < targetSandboxDrainProtocol
  ) {
    throw new Error(
      'platform: The database did not arm the Sandbox admission protocol required by this runtime.',
    );
  }
  const sandboxDrainState = sandboxDrainPreparation?.state ?? 'complete';
  if (
    targetSandboxDrainProtocol >= 1 &&
    (state.manifest.safetyProtocols?.sandboxDrain ?? 0) < targetSandboxDrainProtocol
  ) {
    state.manifest = {
      ...state.manifest,
      safetyProtocols: { sandboxDrain: targetSandboxDrainProtocol },
      updatedAt: now(),
    };
    writeInstallationManifest(state.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, state.manifest);
  }

  state.manifest = transitionInstallation(state.manifest, 'deploying', now());
  await checkpointOperation('deploying');
  writeInstallationManifest(state.manifest);
  const ids = Object.fromEntries(
    state.manifest.resources.map((resource) => [resource.key, resource.id]),
  );
  const bootstrapStep = 'bootstrap-access:v1';
  if (!state.manifest.steps.some((step) => step.key === bootstrapStep)) {
    const routingKv = requireId(ids, 'routing-kv');
    await dependencies.client.putKvValue(plan.account.id, routingKv, 'signup:enabled', 'true');
    await dependencies.client.putKvValue(
      plan.account.id,
      routingKv,
      'signup:allowlist',
      JSON.stringify([]),
    );
    state.manifest = recordInstallationStep(
      state.manifest,
      {
        completedAt: now(),
        key: bootstrapStep,
        resultHash: hash(secrets.authenticationSetupJson ?? secrets.bootstrapGitHubId),
      },
      now(),
    );
    writeInstallationManifest(state.manifest);
  }
  const entrypoints = Object.fromEntries(
    Object.entries(runtime.artifacts).map(([key, artifact]) => [
      key,
      join(runtimeDirectory, artifact.path),
    ]),
  ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string> &
    Partial<Record<'emailGateway', string>>;
  return {
    zone,
    zoneId,
    targetSandboxDrainProtocol,
    prepareSandboxDrain,
    sandboxDrainState,
    ids,
    entrypoints,
  };
}
