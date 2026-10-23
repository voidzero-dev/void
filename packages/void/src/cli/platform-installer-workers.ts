import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  encodeCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  type PlatformInstallationManifest,
} from '@void/platform';
import { dirname, join, resolve } from 'pathslash';
import { getErrorMessage } from './output.ts';
import {
  PlatformWorkerCustomDomainsChangedError,
  PlatformWorkerRoutesChangedError,
  type CloudflareWorkerCustomDomainOrigin,
} from './platform-cloudflare.ts';
import {
  readTriggerConfigFromObject,
  recordWorkerCutoverResolution,
  recordWorkerTrafficState,
  withoutCompletedPlatformWorkerMigrations,
  resolvePlatformPreviousTriggerConfig,
  workerCutoverUpdatesSecrets,
} from './platform-installer-cutover.ts';
import {
  assertPlatformTriggerStabilization,
  assertCleanPlatformWrangler,
} from './platform-installer-errors.ts';
import {
  inspectNewPlatformWorker,
  readPlatformWorkerDeployments,
  deploymentRunsOnlyVersion,
  readActivePlatformWorkerVersion,
  readActivePlatformWorkerSnapshot,
  readPlatformWorkerVersionSnapshot,
  readPlatformWorkerOwnershipMarker,
  classifyPlatformWorkerDeploymentLineage,
  PlatformWorkerOwnershipError,
  samePlatformWorkerTraffic,
} from './platform-installer-inspection.ts';
import {
  runPlatformWrangler,
  platformWorkerCommandRunner,
  runPlatformWranglerForConditionalCreate,
} from './platform-installer-process.ts';
import {
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
  isolatePlatformWorkerCustomDomains,
  mergePreservedTriggerRoutes,
  withoutPlatformCustomDomainTriggers,
  requireId,
  validateReplannedWorkerActions,
  withoutPlatformWorkerTrafficAttachments,
} from './platform-installer-resources.ts';
import {
  type InstallerClient,
  type PlatformInstallerDependencies,
  type InstallationCheckpointWriter,
  type InterruptedWorkerCutover,
  type PlatformWorkerKey,
  type PlatformWorkerDeploymentOptions,
  type PlatformWorkerRollback,
  type PlatformWorkerDeployment,
  PlatformWorkerRecoveryIncompleteError,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';
import { platformWorkerLiveTriggersMatch } from './platform-trigger-proof.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';

export function platformWorkerResourceKey(key: PlatformWorkerKey): string {
  return key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`;
}

/** Callbacks shared by a platform Worker deploy and its interrupted-cutover rollback. */
export function platformWorkerTrafficCallbacks(input: {
  readonly client: InstallerClient;
  readonly accountId: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly key: PlatformWorkerKey;
  readonly workerName: string;
  readonly readManifest: () => PlatformInstallationManifest;
}): Pick<
  PlatformWorkerDeploymentOptions,
  'inspectNewWorker' | 'publishCustomDomains' | 'retainNewWorker'
> {
  const { client, accountId, ids, key, workerName, readManifest } = input;
  return {
    inspectNewWorker: () =>
      inspectNewPlatformWorker(
        client,
        accountId,
        readManifest(),
        platformWorkerResourceKey(key),
        workerName,
      ),
    publishCustomDomains: (name, origins) =>
      client.publishWorkerCustomDomainsSafely(accountId, name, origins),
    retainNewWorker: async () => {
      await client.putKvValue(
        accountId,
        requireId(ids, 'routing-kv'),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
    },
  };
}

// Restore staged Workers, or retain their rotated credentials, before starting
// a new guarded generation. Replan any newly created Worker recovery retained.
export async function recoverInterruptedPlatformWorkerCutover(
  input: Readonly<{
    manifest: PlatformInstallationManifest;
    interruptedCutover: InterruptedWorkerCutover | null;
    workerActions: ReadonlyArray<PlatformInstallPlanAction>;
    configs: ReturnType<typeof createPlatformWorkerConfigs>;
    previousConfigs: ReturnType<typeof createPlatformWorkerConfigs>;
    plan: PlatformInstallPlan;
    dependencies: PlatformInstallerDependencies;
    ids: Record<string, string>;
    previousPublicEndpoints: boolean;
    hasEmailGatewayArtifact: boolean;
    runPinnedPlatformWrangler: typeof runPlatformWrangler;
    now: () => string;
    writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
    onManifestChange: (manifest: PlatformInstallationManifest) => void;
  }>,
): Promise<{
  manifest: PlatformInstallationManifest;
  workerActions: ReadonlyArray<PlatformInstallPlanAction>;
}> {
  const {
    interruptedCutover,
    configs,
    previousConfigs,
    plan,
    dependencies,
    ids,
    previousPublicEndpoints,
    hasEmailGatewayArtifact,
    runPinnedPlatformWrangler,
    now,
    writeRemoteInstallationCheckpoint,
    onManifestChange,
  } = input;
  let { manifest, workerActions } = input;
  if (interruptedCutover) {
    const retainUpdatedCredentials = workerCutoverUpdatesSecrets(
      manifest,
      interruptedCutover.generation,
    );
    const recoveryOrder: ReadonlyArray<PlatformWorkerKey> = [
      'dispatch',
      'tail',
      'emailGateway',
      'proxy',
      'api',
    ];
    for (const key of recoveryOrder.filter((key) => interruptedCutover.staged.has(key))) {
      const snapshot = interruptedCutover.staged.get(key)!;
      const preservedRoutes = dependencies.recoverWorkerCutover
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(
            dependencies.client,
            plan,
            snapshot.workerName,
          );
      const recoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...configs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      const previousRecoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...previousConfigs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      if (retainUpdatedCredentials) {
        // Recovery may have restored some Workers before Cloudflare refused an
        // old secret version. Accept only this cutover's old or staged version;
        // the next guarded generation reapplies the authorized credentials.
        const directory = mkdtempSync(join(tmpdir(), 'void-platform-resume-'));
        try {
          const configPath = join(directory, 'wrangler.json');
          writeFileSync(configPath, JSON.stringify(recoveryConfig), { mode: 0o600 });
          const currentVersionId = await readActivePlatformWorkerVersion(
            configPath,
            plan.account.id,
            snapshot.workerName,
            runPinnedPlatformWrangler,
          );
          if (
            currentVersionId !== snapshot.stagedVersionId &&
            (snapshot.previousVersionId === null || currentVersionId !== snapshot.previousVersionId)
          ) {
            throw new Error(
              `Worker ${snapshot.workerName} changed concurrently after the credential update; refusing to overwrite it.`,
            );
          }
        } finally {
          rmSync(directory, { force: true, recursive: true });
        }
      } else if (dependencies.recoverWorkerCutover) {
        await dependencies.recoverWorkerCutover({
          key,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          previousVersionId: snapshot.previousVersionId,
          stagedVersionId: snapshot.stagedVersionId,
          workerName: snapshot.workerName,
        });
      } else {
        const recoveryTraffic = isolatePlatformWorkerCustomDomains(recoveryConfig);
        const previousRecoveryTraffic = isolatePlatformWorkerCustomDomains(previousRecoveryConfig);
        await rollbackPlatformWorker({
          accountId: plan.account.id,
          activatedDeploymentId: null,
          activatedVersionId: snapshot.stagedVersionId,
          config: recoveryConfig,
          nextTriggers: readTriggerConfigFromObject(recoveryTraffic.wranglerConfig),
          previousConfig: previousRecoveryConfig,
          previousCustomDomains: previousRecoveryTraffic.customDomains,
          previousDeployment: null,
          previousTriggers: mergePreservedTriggerRoutes(
            withoutPlatformCustomDomainTriggers(snapshot.previousTriggers),
            preservedRoutes,
          ),
          previousVersionId: snapshot.previousVersionId,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          ...platformWorkerTrafficCallbacks({
            client: dependencies.client,
            accountId: plan.account.id,
            ids,
            key,
            workerName: snapshot.workerName,
            readManifest: () => manifest,
          }),
          runner: runPinnedPlatformWrangler,
          workerExisted: snapshot.previousVersionId !== null,
          workerName: snapshot.workerName,
        });
      }
    }
    manifest = recordWorkerCutoverResolution(
      manifest,
      interruptedCutover.generation,
      retainUpdatedCredentials ? 'committed' : 'restored',
      now(),
    );
    manifest = recordWorkerTrafficState(
      manifest,
      interruptedCutover.generation,
      !retainUpdatedCredentials &&
        previousPublicEndpoints &&
        interruptedCutover.unsafeTraffic.size === 0,
      now(),
    );
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    if (
      [...interruptedCutover.staged.values()].some(
        (snapshot) => snapshot.previousVersionId === null,
      )
    ) {
      if (!dependencies.replanWorkers) {
        throw new Error(
          'platform: Recovering retained Workers requires a fresh Cloudflare installation plan.',
        );
      }
      workerActions = validateReplannedWorkerActions(
        plan,
        manifest,
        await dependencies.replanWorkers(manifest),
      ).filter((action) => hasEmailGatewayArtifact || action.key !== 'email-gateway-worker');
    }
  }
  return { manifest, workerActions };
}

let cachedPlatformUploaderHash: string | null | undefined;

function platformWorkerUploaderHash(): string | null {
  if (cachedPlatformUploaderHash !== undefined) {
    return cachedPlatformUploaderHash;
  }
  try {
    const launcher = resolveCloudflareOperationArgv()[1];
    if (!launcher) {
      return (cachedPlatformUploaderHash = null);
    }
    const digest = createHash('sha256');
    digest.update('platform-uploader:v1\0');
    digest.update(process.version);
    digest.update(readFileSync(launcher));
    digest.update(readFileSync(resolve(dirname(launcher), '..', '..', 'package.json')));
    const cfDirectory = dirname(fileURLToPath(import.meta.resolve('cf/package.json')));
    digest.update(readFileSync(join(cfDirectory, 'package.json')));
    digest.update(readFileSync(join(cfDirectory, 'bin', 'cf')));
    const cfCodeHash = platformWorkerDirectoryHash(join(cfDirectory, 'dist'));
    if (!cfCodeHash) {
      throw new Error('Cloudflare CLI code is unavailable.');
    }
    digest.update(cfCodeHash);
    let dependencyDirectory = dirname(
      fileURLToPath(import.meta.resolve('@cloudflare/build-output-utils')),
    );
    while (!existsSync(join(dependencyDirectory, 'package.json'))) {
      const parent = dirname(dependencyDirectory);
      if (parent === dependencyDirectory) {
        throw new Error('Cloudflare build output package is unavailable.');
      }
      dependencyDirectory = parent;
    }
    digest.update(readFileSync(join(dependencyDirectory, 'package.json')));
    const buildOutputCodeHash = platformWorkerDirectoryHash(join(dependencyDirectory, 'dist'));
    if (!buildOutputCodeHash) {
      throw new Error('Cloudflare build output code is unavailable.');
    }
    digest.update(buildOutputCodeHash);
    const visited = new Set<string>();
    const visit = (path: string, name: string) => {
      if (visited.has(path)) {
        return;
      }
      visited.add(path);
      const source = readFileSync(path);
      digest.update(`${name}\0`);
      digest.update(source);
      const imports = [
        ...source
          .toString('utf8')
          .matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g),
      ]
        .map((match) => match[1]!)
        .sort();
      for (const specifier of imports) {
        visit(resolve(dirname(path), specifier), specifier);
      }
    };
    visit(launcher, 'launcher');
    return (cachedPlatformUploaderHash = digest.digest('hex'));
  } catch {
    return (cachedPlatformUploaderHash = null);
  }
}

function platformWorkerDirectoryHash(directory: string): string | null {
  if (!lstatSync(directory).isDirectory()) {
    return null;
  }
  const digest = createHash('sha256');
  const visit = (path: string, prefix: string): boolean => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = `${prefix}${entry.name}`;
      const absolutePath = join(path, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory:${relativePath}\0`);
        if (!visit(absolutePath, `${relativePath}/`)) {
          return false;
        }
      } else if (entry.isFile()) {
        digest.update(`file:${relativePath}\0`);
        digest.update(createHash('sha256').update(readFileSync(absolutePath)).digest('hex'));
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(directory, '') ? digest.digest('hex') : null;
}

/** Hash every input that can change a version upload; missing or unusual files disable reuse. */
export function platformWorkerUploadFingerprint(
  config: Record<string, unknown>,
  managedRoutes: ReadonlyArray<string> = [],
): string | null {
  const uploaderHash = platformWorkerUploaderHash();
  if (typeof config.main !== 'string' || !uploaderHash) {
    return null;
  }
  try {
    const main = lstatSync(config.main);
    if (!main.isFile()) {
      return null;
    }
    const mainSha256 = createHash('sha256').update(readFileSync(config.main)).digest('hex');
    const normalized: Record<string, unknown> = { ...config, main: { sha256: mainSha256 } };
    if (config.assets !== undefined) {
      const assets = config.assets;
      if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
        return null;
      }
      const directory = (assets as Record<string, unknown>).directory;
      if (typeof directory !== 'string') {
        return null;
      }
      const assetsHash = platformWorkerDirectoryHash(directory);
      if (!assetsHash) {
        return null;
      }
      normalized.assets = {
        ...(assets as Record<string, unknown>),
        directory: assetsHash,
      };
    }
    return createHash('sha256')
      .update(JSON.stringify({ schema: 2, config: normalized, managedRoutes, uploaderHash }))
      .digest('hex');
  } catch {
    return null;
  }
}

function snapshotPlatformWorkerUploadInputs(
  config: Record<string, unknown>,
  directory: string,
): Record<string, unknown> {
  const main = config.main;
  if (typeof main !== 'string') {
    throw new Error('platform: Worker upload has no script artifact.');
  }
  const snapshotMain = join(directory, 'worker-upload.js');
  copyFileSync(main, snapshotMain);
  const snapshot: Record<string, unknown> = { ...config, main: snapshotMain };
  if (config.assets !== undefined) {
    const assets = config.assets as Record<string, unknown>;
    const sourceDirectory = assets.directory;
    if (typeof sourceDirectory !== 'string') {
      throw new Error('platform: Worker upload has no assets directory.');
    }
    const snapshotDirectory = join(directory, 'worker-assets');
    cpSync(sourceDirectory, snapshotDirectory, { recursive: true });
    snapshot.assets = { ...assets, directory: snapshotDirectory };
  }
  return snapshot;
}

function platformWorkerApiReadRunner(
  accountId: string,
  workerName: string,
  readCloudflare: (path: string) => Promise<unknown>,
  fallback: typeof runPlatformWrangler,
): typeof runPlatformWrangler {
  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  return async (operation, account, cwd, capture) => {
    try {
      if (operation.type === 'deployments.status' || operation.type === 'deployments.list') {
        const response = await readCloudflare(`${base}/deployments`);
        const deployments =
          response && typeof response === 'object' && !Array.isArray(response)
            ? (response as { deployments?: unknown }).deployments
            : null;
        if (!Array.isArray(deployments)) {
          throw new Error(
            `platform: Cloudflare returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          status: operation.type === 'deployments.status' && deployments.length === 0 ? 1 : 0,
          stderr: '',
          stdout: '',
          data: operation.type === 'deployments.status' ? deployments[0] : deployments,
        };
      }
      if (operation.type === 'versions.view') {
        const version = await readCloudflare(
          `${base}/versions/${encodeURIComponent(operation.versionId)}`,
        );
        return { status: 0, stderr: '', stdout: '', data: version };
      }
    } catch {
      // A failed read is not evidence of ownership or deployment lineage.
      // Keep the same provider check through the scoped operation runner.
    }
    return fallback(operation, account, cwd, capture);
  };
}

export async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  options: PlatformWorkerDeploymentOptions,
): Promise<PlatformWorkerRollback | null> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  const readRunner = options.readCloudflare
    ? platformWorkerApiReadRunner(accountId, workerName, options.readCloudflare, options.runner)
    : options.runner;
  let activatedVersionId: string | null = null;
  let activatedDeploymentId: string | null = null;
  let uploadedVersionId: string | null = null;
  let previousDeployment: PlatformWorkerDeployment | null = null;
  let previousDeploymentId: string | null = null;
  let previousVersionId: string | null = null;
  const nextTraffic = isolatePlatformWorkerCustomDomains(config);
  const previousTraffic = isolatePlatformWorkerCustomDomains(options.previousConfig);
  let uploadConfig = withoutPlatformWorkerTrafficAttachments(nextTraffic.wranglerConfig);
  const nextTriggers = readTriggerConfigFromObject(nextTraffic.wranglerConfig);
  const contentHash =
    secrets === null ? platformWorkerUploadFingerprint(config, options.managedRoutes) : null;
  const reuseMatchingVersion = options.reuseMatchingVersion !== false;
  let previousTriggers = readTriggerConfigFromObject(previousTraffic.wranglerConfig);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const reconcileExistingVersion = async (
      versionId: string,
      triggerConfig: CloudflareTriggerConfig,
      runner: typeof runPlatformWrangler,
      deploymentId?: string,
    ): Promise<null> => {
      // A reused version still needs its mutable traffic state reconciled.
      try {
        const liveTriggersMatch =
          deploymentId && options.readCloudflare
            ? await platformWorkerLiveTriggersMatch({
                accountId,
                workerName,
                desired: nextTriggers,
                readCloudflare: options.readCloudflare,
              })
            : false;
        if (liveTriggersMatch) {
          const beforeTraffic = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (
            beforeTraffic[0]?.id !== deploymentId ||
            !deploymentRunsOnlyVersion(beforeTraffic[0], versionId)
          ) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during trigger verification.`,
            );
          }
        } else {
          const triggers = await stabilizeCloudflareVersionTriggers({
            configPath,
            knownTriggerConfigs: { [versionId]: nextTriggers },
            manageRoutes: false,
            previousTriggerConfig: triggerConfig,
            runWrangler: platformWorkerCommandRunner(accountId, directory, runner),
            targetTriggerConfig: nextTriggers,
            targetVersionId: versionId,
            workerName,
          });
          assertPlatformTriggerStabilization(triggers, workerName, versionId, 'publish');
        }
        if (nextTraffic.customDomains.length > 0) {
          await options.publishCustomDomains(workerName, nextTraffic.customDomains);
        }
        if (options.managedRoutes.length > 0) {
          await options.publishRoutes(workerName, options.managedRoutes);
        }
        await options.onTrafficPublished();
        if (
          !deploymentId &&
          (await readActivePlatformWorkerVersion(configPath, accountId, workerName, runner)) !==
            versionId
        ) {
          throw new Error(`platform: Worker ${workerName} changed during traffic reconciliation.`);
        }
        if (deploymentId) {
          const after = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (after[0]?.id !== deploymentId || !deploymentRunsOnlyVersion(after[0], versionId)) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during reconciliation.`,
            );
          }
        }
        return null;
      } catch (error) {
        const failures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} traffic reconciliation failed: ${getErrorMessage(error)}${
            failures.length > 0 ? ` Safety recovery also failed: ${failures.join('; ')}` : ''
          }`,
          { cause: error },
        );
      }
    };
    if (options.workerExisted && contentHash && reuseMatchingVersion && options.readCloudflare) {
      let candidate:
        | {
            deploymentId: string;
            snapshot: Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>;
          }
        | undefined;
      let changedDuringRead = false;
      try {
        const before = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        const activeVersion =
          before[0]?.versions.length === 1 && before[0].versions[0]?.percentage === 100
            ? before[0].versions[0].versionId
            : null;
        if (!activeVersion) {
          throw new Error(
            `platform: Existing Worker ${workerName} has no single active production version.`,
          );
        }
        const snapshot = await readPlatformWorkerVersionSnapshot(
          configPath,
          accountId,
          workerName,
          readPlatformWorkerOwnershipMarker(config),
          activeVersion,
          readRunner,
        );
        const after = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        changedDuringRead =
          before[0]?.id !== after[0]?.id ||
          !deploymentRunsOnlyVersion(after[0], snapshot.versionId);
        if (!changedDuringRead && snapshot.contentHash === contentHash) {
          candidate = { deploymentId: after[0]!.id, snapshot };
        }
      } catch (error) {
        if (error instanceof PlatformWorkerOwnershipError) {
          throw error;
        }
        // A read error is not evidence of equality; use the established upload path.
      }
      if (changedDuringRead) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      if (
        candidate &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          candidate.snapshot.versionId,
          candidate.snapshot.triggerConfig,
          readRunner,
          candidate.deploymentId,
        );
      }
    }
    if (options.workerExisted) {
      const previous = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        workerName,
        readPlatformWorkerOwnershipMarker(config),
        readRunner,
        options.replaceOutsideChanges ? previousTriggers : undefined,
      );
      previousVersionId = previous.versionId;
      const deployments = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (!deploymentRunsOnlyVersion(deployments[0], previousVersionId)) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      previousDeployment = deployments[0]!;
      previousDeploymentId = previousDeployment.id;
      if (
        contentHash &&
        reuseMatchingVersion &&
        previous.contentHash === contentHash &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          previousVersionId,
          previous.triggerConfig,
          readRunner,
        );
      }
      uploadConfig = withoutCompletedPlatformWorkerMigrations(uploadConfig, previous.migrationTag);
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
        mode: 0o600,
      });
      previousTriggers = resolvePlatformPreviousTriggerConfig(
        withoutPlatformCustomDomainTriggers(previous.triggerConfig),
        previousTriggers,
        options.previousPublicEndpoints,
      );
      previousTriggers = withoutPlatformCustomDomainTriggers(
        mergePreservedTriggerRoutes(previousTriggers, options.preservedRoutes),
      );
    }
    const immutableConfig = contentHash
      ? snapshotPlatformWorkerUploadInputs(config, directory)
      : null;
    const uploadedContentHash = immutableConfig
      ? platformWorkerUploadFingerprint(immutableConfig, options.managedRoutes)
      : null;
    if (immutableConfig) {
      uploadConfig = {
        ...uploadConfig,
        main: immutableConfig.main,
        ...(immutableConfig.assets === undefined ? {} : { assets: immutableConfig.assets }),
      };
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, { mode: 0o600 });
    }
    const operation: CloudflareOperation = {
      type: options.workerExisted ? 'versions.upload' : 'worker.deploy',
      configPath,
      message: encodeCloudflareVersionMessage([], nextTriggers, uploadedContentHash ?? undefined),
    };
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      operation.secretsFilePath = secretsPath;
    }
    const releaseUploadSlot = await options.acquireUploadSlot?.();
    let uploaded: CloudflareCommandResult;
    let uploadError: unknown;
    try {
      uploaded = options.workerExisted
        ? await options.runner(operation, accountId, directory, true)
        : await runPlatformWranglerForConditionalCreate(
            operation,
            accountId,
            directory,
            true,
            workerName,
            options.apiBaseUrl,
            options.operatorApiToken,
          );
      assertCleanPlatformWrangler(
        uploaded,
        `${options.workerExisted ? 'upload' : 'bootstrap'} ${workerName}`,
        accountId,
      );
    } catch (error) {
      uploadError = error;
      throw error;
    } finally {
      releaseUploadSlot?.(uploadError);
    }
    const uploadData = uploaded.data as { versionId?: unknown } | undefined;
    uploadedVersionId = typeof uploadData?.versionId === 'string' ? uploadData.versionId : null;
    if (!options.workerExisted) {
      activatedVersionId = uploadedVersionId;
    }
    if (!uploadedVersionId) {
      throw new Error(
        `platform: Wrangler uploaded ${workerName} without reporting its immutable version id.`,
      );
    }
    await options.onStaged(previousVersionId, uploadedVersionId, previousTriggers);
    await options.onReadyForActivation?.();
    await options.waitForPriorWorker?.();
    if (options.workerExisted) {
      const deploymentsBeforeActivation = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (
        deploymentsBeforeActivation[0]?.id !== previousDeploymentId ||
        !deploymentRunsOnlyVersion(deploymentsBeforeActivation[0], previousVersionId)
      ) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently before activation; refusing to overwrite it.`,
        );
      }
      activatedVersionId = uploadedVersionId;
      const activated = await options.runner(
        {
          type: 'versions.deploy',
          configPath,
          versions: [{ versionId: uploadedVersionId, percentage: 100 }],
          message: `Void platform activation ${uploadedVersionId}`,
        },
        accountId,
        directory,
        true,
      );
      assertCleanPlatformWrangler(activated, `activate ${workerName}`, accountId);
    }
    const deploymentsAfterActivation = await readPlatformWorkerDeployments(
      configPath,
      accountId,
      workerName,
      readRunner,
    );
    const lineage = classifyPlatformWorkerDeploymentLineage(
      deploymentsAfterActivation,
      uploadedVersionId,
      previousDeploymentId,
    );
    if (lineage.kind === 'concurrent-after') {
      activatedVersionId = null;
      throw new Error(
        `platform: Worker ${workerName} changed concurrently after activation; refusing to overwrite the newer deployment.`,
      );
    }
    activatedDeploymentId = lineage.deploymentId;
    if (lineage.kind === 'intervening') {
      const interveningDeployment = deploymentsAfterActivation[1];
      activatedVersionId = null;
      activatedDeploymentId = null;
      if (!interveningDeployment) {
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} lost its previous deployment during activation. The cutover cannot be recovered automatically.`,
        );
      }
      try {
        await restorePlatformWorkerDeployment({
          accountId,
          configPath,
          directory,
          expectedActiveDeploymentId: lineage.deploymentId,
          expectedActiveVersionId: uploadedVersionId,
          restoration: interveningDeployment,
          runner: readRunner,
          workerName,
        });
      } catch (recoveryError) {
        const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} changed concurrently during activation, and restoring intervening deployment ${interveningDeployment.id} failed: ${getErrorMessage(recoveryError)}${
            recoveryFailures.length > 0
              ? ` Safety recovery also failed: ${recoveryFailures.join('; ')}`
              : ''
          }`,
          { cause: recoveryError },
        );
      }
      throw new Error(
        `platform: Worker ${workerName} changed concurrently during activation. The intervening deployment was restored without deleting deployment history.`,
      );
    }
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath,
      knownTriggerConfigs: {
        [uploadedVersionId]: nextTriggers,
        ...(previousVersionId ? { [previousVersionId]: previousTriggers } : {}),
      },
      manageRoutes: false,
      previousTriggerConfig: previousTriggers,
      runWrangler: platformWorkerCommandRunner(accountId, directory, readRunner),
      targetTriggerConfig: nextTriggers,
      targetVersionId: uploadedVersionId,
      workerName,
    });
    assertPlatformTriggerStabilization(triggers, workerName, uploadedVersionId, 'publish');
    if (nextTraffic.customDomains.length > 0) {
      await options.publishCustomDomains(workerName, nextTraffic.customDomains);
    }
    if (options.managedRoutes.length > 0) {
      await options.publishRoutes(workerName, options.managedRoutes);
    }
    await options.onTrafficPublished();
    const rollback = () =>
      rollbackPlatformWorker({
        accountId,
        activatedDeploymentId,
        activatedVersionId: uploadedVersionId!,
        config,
        nextTriggers,
        previousConfig: options.previousConfig,
        previousCustomDomains: previousTraffic.customDomains,
        previousDeployment,
        previousTriggers,
        previousVersionId,
        preserveCustomDomains: false,
        inspectNewWorker: options.inspectNewWorker,
        publishCustomDomains: options.publishCustomDomains,
        retainNewWorker: options.retainNewWorker,
        runner: readRunner,
        workerExisted: options.workerExisted,
        workerName,
      });
    return rollback;
  } catch (error) {
    const unsafeTraffic =
      error instanceof PlatformWorkerCustomDomainsChangedError ||
      error instanceof PlatformWorkerRoutesChangedError;
    const rollbackVersionId = activatedVersionId && uploadedVersionId ? uploadedVersionId : null;
    const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
      checkpointUnsafeTraffic: options.onUnsafeTraffic,
      closeRoutingGate: options.retainNewWorker,
      rollback: rollbackVersionId
        ? () =>
            rollbackPlatformWorker({
              accountId,
              activatedDeploymentId,
              activatedVersionId: rollbackVersionId,
              config,
              nextTriggers,
              previousConfig: options.previousConfig,
              previousCustomDomains: previousTraffic.customDomains,
              previousDeployment,
              previousTriggers,
              previousVersionId,
              preserveCustomDomains: unsafeTraffic,
              inspectNewWorker: options.inspectNewWorker,
              publishCustomDomains: options.publishCustomDomains,
              retainNewWorker: options.retainNewWorker,
              runner: readRunner,
              workerExisted: options.workerExisted,
              workerName,
            })
        : null,
      unsafeTraffic,
    });
    if (recoveryFailures.length > 0) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${getErrorMessage(error)} Automatic recovery for ${workerName} was incomplete: ${recoveryFailures.join('; ')}`,
        { cause: error },
      );
    }
    if (unsafeTraffic) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${getErrorMessage(error)} The routing gate remains closed and live Custom Domains were retained for safe reconciliation on retry.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * Upload a version of a platform Worker that was changed outside Void, and do
 * not deploy it. The Cloudflare CLI uses this terminal: it shows what the
 * upload replaces and asks the operator. After the operator agrees, later
 * uploads of this Worker work without a terminal again.
 */
export async function uploadPlatformWorkerForReview(
  config: Record<string, unknown>,
  options: Readonly<{
    readCloudflare: (path: string) => Promise<unknown>;
    runner: typeof runPlatformWrangler;
  }>,
): Promise<CloudflareCommandResult> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-review-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  const readRunner = platformWorkerApiReadRunner(
    accountId,
    workerName,
    options.readCloudflare,
    options.runner,
  );
  try {
    const { wranglerConfig } = isolatePlatformWorkerCustomDomains(config);
    const configPath = join(directory, 'wrangler.json');
    const writeConfig = (value: Record<string, unknown>) =>
      writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    writeConfig(withoutPlatformWorkerTrafficAttachments(wranglerConfig));
    // Like deployPlatformWorker, leave out the Durable Object migrations that
    // the active version already ran.
    const active = await readActivePlatformWorkerSnapshot(
      configPath,
      accountId,
      workerName,
      readPlatformWorkerOwnershipMarker(config),
      readRunner,
      readTriggerConfigFromObject(wranglerConfig),
    );
    writeConfig(
      withoutCompletedPlatformWorkerMigrations(
        withoutPlatformWorkerTrafficAttachments(wranglerConfig),
        active.migrationTag,
      ),
    );
    return await options.runner(
      {
        type: 'versions.upload',
        configPath,
        message: 'Void: replace changes made outside Void',
        interactive: true,
      },
      accountId,
      directory,
      true,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function recoverFailedPlatformWorkerDeployment(input: {
  checkpointUnsafeTraffic: () => Promise<void>;
  closeRoutingGate: () => Promise<void>;
  rollback: (() => Promise<void>) | null;
  unsafeTraffic: boolean;
}): Promise<Array<string>> {
  const failures: Array<string> = [];
  const attempt = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${getErrorMessage(error)}`);
    }
  };
  if (input.unsafeTraffic) {
    await attempt('closing the routing gate failed', input.closeRoutingGate);
    await attempt('checkpointing unsafe traffic failed', input.checkpointUnsafeTraffic);
  }
  if (input.rollback) {
    await attempt('Worker rollback failed', input.rollback);
  }
  return failures;
}

async function rollbackPlatformWorker(input: {
  accountId: string;
  activatedDeploymentId: string | null;
  activatedVersionId: string;
  config: Record<string, unknown>;
  nextTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousConfig: Record<string, unknown>;
  previousCustomDomains: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>;
  previousDeployment: PlatformWorkerDeployment | null;
  previousTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousVersionId: string | null;
  preserveCustomDomains: boolean;
  inspectNewWorker: () => Promise<'missing' | 'owned'>;
  publishCustomDomains: (
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ) => Promise<void>;
  retainNewWorker: () => Promise<void>;
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
  workerName: string;
}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-rollback-'));
  try {
    const configPath = join(directory, 'wrangler.json');
    const currentTraffic = isolatePlatformWorkerCustomDomains(input.config);
    writeFileSync(configPath, `${JSON.stringify(currentTraffic.wranglerConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    if (!input.workerExisted) {
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      const currentVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (currentVersionId !== input.activatedVersionId) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to delete it.`,
        );
      }
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      await input.retainNewWorker();
      return;
    }
    const currentVersionId = await readActivePlatformWorkerVersion(
      configPath,
      input.accountId,
      input.workerName,
      input.runner,
    );
    if (
      currentVersionId !== input.previousVersionId &&
      currentVersionId !== input.activatedVersionId
    ) {
      throw new Error(
        `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to overwrite it.`,
      );
    }
    if (!input.previousVersionId) {
      throw new Error(`Worker ${input.workerName} has no previous version to restore.`);
    }
    if (currentVersionId === input.activatedVersionId) {
      const currentDeployments = await readPlatformWorkerDeployments(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      const activeDeploymentId = input.activatedDeploymentId ?? currentDeployments[0]?.id ?? null;
      const restoration = input.previousDeployment ?? currentDeployments[1];
      if (
        !activeDeploymentId ||
        currentDeployments[0]?.id !== activeDeploymentId ||
        !deploymentRunsOnlyVersion(currentDeployments[0], input.activatedVersionId) ||
        !restoration ||
        currentDeployments[1]?.id !== restoration.id ||
        !deploymentRunsOnlyVersion(restoration, input.previousVersionId)
      ) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently after installer deployment; refusing to alter its deployment history.`,
        );
      }
      await restorePlatformWorkerDeployment({
        accountId: input.accountId,
        configPath,
        directory,
        expectedActiveDeploymentId: activeDeploymentId,
        expectedActiveVersionId: input.activatedVersionId,
        restoration,
        runner: input.runner,
        workerName: input.workerName,
      });
      const restoredVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (restoredVersionId !== input.previousVersionId) {
        throw new Error(
          `Worker ${input.workerName} did not restore immutable version ${input.previousVersionId} after rolling back installer deployment ${activeDeploymentId}.`,
        );
      }
    }
    const previousConfigPath = join(directory, 'wrangler.previous.json');
    writeFileSync(previousConfigPath, `${JSON.stringify(input.previousConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath: previousConfigPath,
      knownTriggerConfigs: {
        [input.activatedVersionId]: input.nextTriggers,
        [input.previousVersionId]: input.previousTriggers,
      },
      manageRoutes: false,
      previousTriggerConfig: input.nextTriggers,
      runWrangler: platformWorkerCommandRunner(input.accountId, directory, input.runner),
      targetTriggerConfig: input.previousTriggers,
      targetVersionId: input.previousVersionId,
      workerName: input.workerName,
    });
    assertPlatformTriggerStabilization(
      triggers,
      input.workerName,
      input.previousVersionId,
      'restore',
    );
    if (!input.preserveCustomDomains && input.previousCustomDomains.length > 0) {
      await input.publishCustomDomains(input.workerName, input.previousCustomDomains);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function restorePlatformWorkerDeployment(input: {
  accountId: string;
  configPath: string;
  directory: string;
  expectedActiveDeploymentId: string;
  expectedActiveVersionId: string;
  restoration: PlatformWorkerDeployment;
  runner: typeof runPlatformWrangler;
  workerName: string;
}): Promise<void> {
  const restorationVersions = input.restoration.versions.filter(
    (version) => version.percentage > 0,
  );
  const totalPercentage = restorationVersions.reduce(
    (total, version) => total + version.percentage,
    0,
  );
  if (
    restorationVersions.length === 0 ||
    restorationVersions.length > 2 ||
    restorationVersions.some(
      (version, index) =>
        version.percentage > 100 ||
        restorationVersions.findIndex((entry) => entry.versionId === version.versionId) !== index,
    ) ||
    Math.abs(totalPercentage - 100) > 0.001
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment ${input.restoration.id} has an unsupported traffic distribution.`,
    );
  }
  const before = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    before[0]?.id !== input.expectedActiveDeploymentId ||
    !deploymentRunsOnlyVersion(before[0], input.expectedActiveVersionId) ||
    before[1]?.id !== input.restoration.id ||
    !samePlatformWorkerTraffic(before[1], input.restoration)
  ) {
    throw new Error(
      `Worker ${input.workerName} changed concurrently before deployment restoration; refusing to overwrite the newer deployment.`,
    );
  }
  const restored = await input.runner(
    {
      type: 'versions.deploy',
      configPath: input.configPath,
      versions: restorationVersions.map((version) => ({
        versionId: version.versionId,
        percentage: version.percentage,
      })),
      message: `Void platform restoration ${input.restoration.id}`,
    },
    input.accountId,
    input.directory,
    true,
  );
  assertCleanPlatformWrangler(
    restored,
    `restore deployment ${input.restoration.id}`,
    input.accountId,
  );
  const after = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    !samePlatformWorkerTraffic(after[0], input.restoration) ||
    after[1]?.id !== input.expectedActiveDeploymentId
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment restoration was superseded or did not restore deployment ${input.restoration.id}.`,
    );
  }
}

export { runPlatformWrangler, runPlatformWranglerAtApiBase } from './platform-installer-process.ts';

export {
  nextTrafficGeneration,
  nextWorkerCutoverGeneration,
  recordWorkerSecretUpdateState,
  recordWorkerCutoverStage,
  recordWorkerCutoverResolution,
  recordWorkerUnsafeTraffic,
  interruptedWorkerCutover,
  verifyPlatformWorkerCutoverVersions,
  recordWorkerTrafficState,
  stablePublicEndpointState,
} from './platform-installer-cutover.ts';

export { inspectNewPlatformWorker } from './platform-installer-inspection.ts';
