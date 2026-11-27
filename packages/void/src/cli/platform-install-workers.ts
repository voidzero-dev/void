import { recordInstallationStep } from '@void/platform';
import type { createPlatformWorkerConfigs } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { writePlatformTiming } from './platform-installer-process.ts';
import {
  recordResource,
  recordProvisionIntent,
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
} from './platform-installer-resources.ts';
import { platformWorkerSecretPayload } from './platform-installer-secrets.ts';
import type {
  InstallationCheckpointWriter,
  InstallerClient,
  PlatformInstallerDependencies,
  PlatformWorkerDeploymentOptions,
  PlatformInstallationSecrets,
  PlatformInstallRunState,
  PlatformWorkerKey,
} from './platform-installer-types.ts';
import type { runPlatformWrangler } from './platform-installer-workers.ts';
import {
  deployPlatformWorker,
  platformWorkerResourceKey,
  platformWorkerTrafficCallbacks,
  recordWorkerCutoverStage,
  recordWorkerUnsafeTraffic,
} from './platform-installer-workers.ts';
import type { PlatformInstallPlan, PlatformInstallPlanAction } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';
import type { platformManagedWorkerTraffic } from './platform-traffic.ts';
import { recordPlatformWorkerTraffic } from './platform-traffic.ts';

export function platformWorkerAction(
  workerActions: ReadonlyArray<PlatformInstallPlanAction>,
  key: PlatformWorkerKey,
): PlatformInstallPlanAction {
  const resourceKey = platformWorkerResourceKey(key);
  const action = workerActions.find((entry) => entry.key === resourceKey);
  if (!action) {
    throw new Error(`platform: The plan is missing the ${resourceKey} Worker action.`);
  }
  return action;
}

/** Deploy callbacks shared by the upload and enable phases for one platform Worker. */
export function platformWorkerDeployCallbacks(input: {
  readonly client: InstallerClient;
  readonly plan: PlatformInstallPlan;
  readonly zoneId: string;
  readonly ids: { [k: string]: string };
  readonly key: PlatformWorkerKey;
  readonly action: PlatformInstallPlanAction;
  readonly generation: number;
  readonly provisionsDurableObject?: boolean;
  readonly now: () => string;
  readonly readManifest: () => PlatformInstallationManifest;
  readonly writeManifest: (manifest: PlatformInstallationManifest) => Promise<void>;
  readonly checkpoint: (update: () => Promise<void>, safetyRecovery?: boolean) => Promise<void>;
}): Pick<
  PlatformWorkerDeploymentOptions,
  | 'readCloudflare'
  | 'onStaged'
  | 'onTrafficPublished'
  | 'onUnsafeTraffic'
  | 'publishCustomDomains'
  | 'publishRoutes'
  | 'inspectNewWorker'
  | 'retainNewWorker'
> {
  const {
    client,
    plan,
    zoneId,
    ids,
    key,
    action,
    generation,
    now,
    readManifest,
    writeManifest,
    checkpoint,
  } = input;
  return {
    readCloudflare: (path) => client.request(path),
    onStaged: async (previousVersionId, stagedVersionId, previousTriggers) => {
      await checkpoint(async () => {
        const completedAt = now();
        let next = recordWorkerCutoverStage(
          readManifest(),
          generation,
          key,
          previousVersionId,
          stagedVersionId,
          action.name,
          previousTriggers,
          completedAt,
        );
        // Save roll-forward intent with the version id, before Cloudflare can activate it.
        if (input.provisionsDurableObject) {
          next = recordInstallationStep(
            next,
            {
              key: `worker-scheduler-migration:${generation}`,
              resultHash: 'SecurityScanScheduler',
              completedAt,
            },
            completedAt,
          );
        }
        await writeManifest(next);
      });
    },
    onTrafficPublished: async () => {
      const [customDomains, routes] = await Promise.all([
        client.listWorkerDomains(plan.account.id),
        zoneId ? client.listWorkerRoutes(zoneId) : Promise.resolve([]),
      ]);
      await checkpoint(async () => {
        const manifest = readManifest();
        const next = recordPlatformWorkerTraffic(
          manifest,
          action.name,
          { customDomains, routes },
          now(),
        );
        if (JSON.stringify(next.resources) !== JSON.stringify(manifest.resources)) {
          await writeManifest(next);
        }
      });
    },
    onUnsafeTraffic: async () => {
      await checkpoint(async () => {
        await writeManifest(
          recordWorkerUnsafeTraffic(readManifest(), generation, key, action.name, now()),
        );
      }, true);
    },
    ...platformWorkerTrafficCallbacks({
      client,
      accountId: plan.account.id,
      ids,
      key,
      workerName: action.name,
      readManifest,
    }),
    publishRoutes: async (workerName, patterns) => {
      if (zoneId) {
        await client.publishWorkerRoutesSafely(zoneId, workerName, patterns);
      } else if (patterns.length > 0) {
        throw new Error('platform: Cannot publish zone routes in workers.dev mode.');
      }
    },
  };
}

export async function uploadInstallationWorkers(input: {
  readonly state: PlatformInstallRunState;
  readonly dependencies: PlatformInstallerDependencies;
  readonly requiresStagedCommit: boolean;
  readonly provisionsDurableObject?: boolean;
  readonly recoveringUnsafeTraffic: boolean;
  readonly workerActions: ReadonlyArray<PlatformInstallPlanAction>;
  readonly workerKeys: ReadonlyArray<PlatformWorkerKey>;
  readonly workerDeploymentSecrets: PlatformInstallationSecrets;
  readonly zoneId: string;
  readonly now: () => string;
  readonly writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  readonly configs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly previousConfigs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly cloudflareApiBaseUrl: string;
  readonly preserveDisabled: boolean;
  readonly managedRoutes: ReturnType<typeof platformManagedWorkerTraffic>['routes'];
  readonly previousPublicEndpoints: boolean;
  readonly ids: { [k: string]: string };
  readonly runParallelPinnedPlatformWrangler: typeof runPlatformWrangler;
  readonly runPinnedPlatformWrangler: typeof runPlatformWrangler;
}): Promise<void> {
  const {
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
  } = input;
  const { plan, workerSecretUpdateIntent, workerCutoverGeneration, workerRollbacks } = state;

  const parallelWorkerUploads =
    !dependencies.deployWorker &&
    !requiresStagedCommit &&
    !workerSecretUpdateIntent &&
    !recoveringUnsafeTraffic &&
    workerActions.length === workerKeys.length &&
    workerActions.every((action) => action.action === 'update');
  let workerManifestQueue = Promise.resolve();
  let workerManifestFailed = false;
  let workerManifestFailure: unknown;
  const checkpointWorkerManifest = (
    update: () => Promise<void>,
    safetyRecovery = false,
  ): Promise<void> => {
    if (!parallelWorkerUploads) {
      return update();
    }
    const result = workerManifestQueue.then(async () => {
      if (workerManifestFailed && !safetyRecovery) {
        throw workerManifestFailure;
      }
      try {
        await update();
      } catch (error) {
        workerManifestFailed = true;
        workerManifestFailure = error;
        throw error;
      }
    });
    workerManifestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const writeManifest = async (next: PlatformInstallationManifest): Promise<void> => {
    state.manifest = next;
    writeInstallationManifest(next);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, next);
  };
  let availableUploadSlots = 2;
  let uploadFailure: unknown;
  const uploadWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const acquireUploadSlot = async (): Promise<(failure?: unknown) => void> => {
    if (uploadFailure !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- Forward the captured upload failure to the next waiter.
      throw uploadFailure;
    }
    if (availableUploadSlots === 0) {
      await new Promise<void>((resolve, reject) => {
        uploadWaiters.push({ resolve, reject });
      });
    } else {
      availableUploadSlots--;
    }
    return (failure) => {
      if (failure !== undefined && uploadFailure === undefined) {
        uploadFailure = failure;
        for (const waiter of uploadWaiters.splice(0)) {
          waiter.reject(failure);
        }
      }
      const next = uploadFailure === undefined ? uploadWaiters.shift() : undefined;
      if (next) {
        next.resolve();
      } else {
        availableUploadSlots++;
      }
    };
  };
  const workerReady = (parallelWorkerUploads ? workerKeys : []).map(() => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  });
  const uploadBatch = Promise.all(workerReady.map((ready) => ready.promise)).then(
    () => ({ error: null }),
    (error: unknown) => ({ error }),
  );
  const deployOneWorker = async (
    key: PlatformWorkerKey,
    waitForPriorWorker?: () => Promise<void>,
    onReadyForActivation?: () => Promise<void>,
  ): Promise<void> => {
    dependencies.onProgress?.(`Deploying the ${key} service`);
    let workerStepStarted = performance.now();
    const markWorkerStep = (step: string) => {
      writePlatformTiming(`worker ${key} ${step}`, workerStepStarted);
      workerStepStarted = performance.now();
    };
    const action = platformWorkerAction(workerActions, key);
    const workerSecrets = platformWorkerSecretPayload(
      key,
      workerDeploymentSecrets,
      plan.account.id,
      zoneId,
      action.action !== 'create',
    );
    await checkpointWorkerManifest(async () => {
      const intended = recordProvisionIntent(state.manifest, action, now());
      if (intended !== state.manifest) {
        await writeManifest(intended);
      }
    });
    await dependencies.revalidateBeforeWorkerDeploy(state.manifest, action);
    markWorkerStep('revalidate');
    const preservedRoutes = dependencies.deployWorker
      ? []
      : action.action === 'create'
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
    markWorkerStep('traffic inventory');
    const workerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
    const previousWorkerConfig = mergePlatformWorkerTrafficConfig(
      previousConfigs[key],
      preservedRoutes,
    );
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
            generation: workerCutoverGeneration,
            provisionsDurableObject: input.provisionsDurableObject,
            now,
            readManifest: () => state.manifest,
            writeManifest,
            checkpoint: checkpointWorkerManifest,
          }),
          apiBaseUrl: cloudflareApiBaseUrl,
          operatorApiToken: dependencies.operatorApiToken,
          ...(parallelWorkerUploads
            ? { acquireUploadSlot, onReadyForActivation, waitForPriorWorker }
            : {}),
          managedRoutes: preserveDisabled
            ? []
            : managedRoutes
                .filter((route) => route.script === action.name)
                .map((route) => route.pattern),
          preservedRoutes,
          previousConfig: previousWorkerConfig,
          provisionsDurableObject: input.provisionsDurableObject,
          previousPublicEndpoints,
          ...(dependencies.replaceOutsideChanges?.includes(action.name)
            ? { replaceOutsideChanges: true }
            : {}),
          runner: parallelWorkerUploads
            ? runParallelPinnedPlatformWrangler
            : runPinnedPlatformWrangler,
          workerExisted: action.action !== 'create',
        });
    markWorkerStep('deploy');
    if (rollback) {
      workerRollbacks.push(rollback);
    }
    await checkpointWorkerManifest(async () => {
      const recorded = recordResource(state.manifest, action, action.name, 'created', now());
      if (
        rollback ||
        dependencies.deployWorker ||
        JSON.stringify(recorded.resources) !== JSON.stringify(state.manifest.resources)
      ) {
        await writeManifest(recorded);
      }
    });
    markWorkerStep('record');
  };
  if (parallelWorkerUploads) {
    const tasks: Array<Promise<void>> = [];
    for (const [index, key] of workerKeys.entries()) {
      const priorWorker = tasks.at(-1);
      const ready = workerReady[index];
      const task = deployOneWorker(key, priorWorker ? () => priorWorker : undefined, async () => {
        ready.resolve();
        const batch = await uploadBatch;
        if (batch.error !== null) {
          // oxlint-disable-next-line typescript/only-throw-error -- Forward the original rejection into the completion promise.
          throw batch.error;
        }
      });
      task.then(
        () => ready.resolve(),
        (error: unknown) => ready.reject(error),
      );
      tasks.push(task);
    }
    const results = await Promise.allSettled(tasks);
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure) {
      throw firstFailure.reason;
    }
  } else {
    for (const key of workerKeys) {
      await deployOneWorker(key);
    }
  }
}
