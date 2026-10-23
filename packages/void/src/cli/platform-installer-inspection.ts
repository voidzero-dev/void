import {
  parseCloudflareVersionMessage,
  readCloudflareVersionMigrationTag,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformResourceOwnershipMarker,
  parsePlatformResourceOwnershipMarker,
  type PlatformInstallationManifest,
} from '@void/platform';
import { assertCleanPlatformWrangler } from './platform-installer-errors.ts';
import { runPlatformWrangler } from './platform-installer-process.ts';
import {
  type PlatformWorkerDeployment,
  type WorkerInspectionClient,
} from './platform-installer-types.ts';

export class PlatformWorkerOwnershipError extends Error {}

export async function readActivePlatformWorkerVersion(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<string | null> {
  const result = await runner(
    { type: 'deployments.status', configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read active version for ${workerName}`, accountId);
  }
  const value = result.data;
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { versions?: unknown }).versions)
  ) {
    throw new Error(`platform: Wrangler returned malformed deployment status for ${workerName}.`);
  }
  const active = (value as { versions: Array<unknown> }).versions.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      Number((entry as { percentage?: unknown }).percentage) === 100,
  );
  if (
    active.length !== 1 ||
    typeof (active[0] as { version_id?: unknown }).version_id !== 'string'
  ) {
    return null;
  }
  return (active[0] as { version_id: string }).version_id;
}

/**
 * The active version in a Cloudflare API answer for the deployments of a
 * platform Worker. deployPlatformWorker continues only when the latest
 * deployment sends all traffic to one version (deploymentRunsOnlyVersion).
 * `split` is each other answer, for example a gradual deployment.
 */
export function readActivePlatformWorkerDeployment(
  response: unknown,
):
  | Readonly<{ kind: 'active'; versionId: string }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'split' }> {
  const deployments =
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as { deployments?: unknown }).deployments
      : null;
  if (!Array.isArray(deployments)) {
    return { kind: 'malformed' };
  }
  if (deployments.length === 0) {
    return { kind: 'split' };
  }
  const latest: unknown = deployments[0];
  const versions =
    latest && typeof latest === 'object' ? (latest as { versions?: unknown }).versions : null;
  if (
    !Array.isArray(versions) ||
    versions.some(
      (version) =>
        !version ||
        typeof version !== 'object' ||
        typeof (version as { version_id?: unknown }).version_id !== 'string' ||
        !Number.isFinite(Number((version as { percentage?: unknown }).percentage)),
    )
  ) {
    return { kind: 'malformed' };
  }
  const [only] = versions as Array<{ percentage: unknown; version_id: string }>;
  return versions.length === 1 && only && Number(only.percentage) === 100
    ? { kind: 'active', versionId: only.version_id }
    : { kind: 'split' };
}

/**
 * Whether a version of a platform Worker has Void's record of its triggers.
 * This is the rule of the upgrade: it refuses a version without the record,
 * for example a version deployed outside Void.
 */
export async function platformWorkerVersionHasTriggerRecord(
  readCloudflare: (path: string) => Promise<unknown>,
  accountId: string,
  workerName: string,
  versionId: string,
): Promise<boolean> {
  const version = await readCloudflare(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`,
  );
  const annotations =
    version && typeof version === 'object'
      ? (version as { annotations?: unknown }).annotations
      : null;
  const message =
    annotations && typeof annotations === 'object'
      ? (annotations as Record<string, unknown>)['workers/message']
      : null;
  return parseCloudflareVersionMessage(typeof message === 'string' ? message : null)?.schema === 2;
}

export async function readPlatformWorkerDeployments(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<ReadonlyArray<PlatformWorkerDeployment>> {
  const result = await runner(
    { type: 'deployments.list', configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read deployment lineage for ${workerName}`, accountId);
  }
  const value = result.data;
  if (!Array.isArray(value)) {
    throw new Error(`platform: Wrangler returned malformed deployment history for ${workerName}.`);
  }
  return value
    .map((entry, index) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { created_on?: unknown }).created_on !== 'string' ||
        !Array.isArray((entry as { versions?: unknown }).versions)
      ) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const createdAt = Date.parse((entry as { created_on: string }).created_on);
      if (!Number.isFinite(createdAt)) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const versions = (entry as { versions: Array<unknown> }).versions.map((version) => {
        if (
          !version ||
          typeof version !== 'object' ||
          typeof (version as { version_id?: unknown }).version_id !== 'string' ||
          !Number.isFinite(Number((version as { percentage?: unknown }).percentage))
        ) {
          throw new Error(
            `platform: Wrangler returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          percentage: Number((version as { percentage: unknown }).percentage),
          versionId: (version as { version_id: string }).version_id,
        };
      });
      return { createdAt, id: (entry as { id: string }).id, index, versions };
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.index - right.index)
    .map(({ id, versions }) => ({ id, versions }));
}

export function samePlatformWorkerTraffic(
  left: PlatformWorkerDeployment | undefined,
  right: PlatformWorkerDeployment,
): boolean {
  if (!left) {
    return false;
  }
  const normalize = (deployment: PlatformWorkerDeployment) =>
    deployment.versions
      .filter((version) => version.percentage > 0)
      .map((version) => `${version.versionId}@${version.percentage}`)
      .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function deploymentRunsOnlyVersion(
  deployment: PlatformWorkerDeployment | undefined,
  versionId: string | null,
): boolean {
  return (
    versionId !== null &&
    deployment?.versions.length === 1 &&
    deployment.versions[0]?.versionId === versionId &&
    deployment.versions[0].percentage === 100
  );
}

export function classifyPlatformWorkerDeploymentLineage(
  deployments: ReadonlyArray<PlatformWorkerDeployment>,
  installedVersionId: string,
  previousDeploymentId: string | null,
):
  | Readonly<{ deploymentId: string; kind: 'committed' }>
  | Readonly<{ kind: 'concurrent-after' }>
  | Readonly<{ deploymentId: string; kind: 'intervening' }> {
  const installed = deployments[0];
  if (!deploymentRunsOnlyVersion(installed, installedVersionId)) {
    return { kind: 'concurrent-after' };
  }
  return (deployments[1]?.id ?? null) === previousDeploymentId
    ? { deploymentId: installed.id, kind: 'committed' }
    : { deploymentId: installed.id, kind: 'intervening' };
}

export async function inspectNewPlatformWorker(
  client: WorkerInspectionClient,
  accountId: string,
  manifest: PlatformInstallationManifest,
  resourceKey: string,
  workerName: string,
): Promise<'missing' | 'owned'> {
  const workerNames = await client.listWorkerNames(accountId);
  if (!workerNames.includes(workerName)) {
    return 'missing';
  }
  const bindings = await client.getWorkerPlainTextBindings(accountId, workerName);
  let marker;
  try {
    marker = parsePlatformResourceOwnershipMarker(
      JSON.parse(bindings.PLATFORM_OWNERSHIP_MARKER ?? 'null'),
    );
  } catch {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: workerName,
    resourceKey,
    resourceKind: 'worker',
    resourceName: workerName,
  });
  if (
    marker.accountId !== expected.accountId ||
    marker.installationId !== expected.installationId ||
    marker.ownershipNonce !== expected.ownershipNonce ||
    marker.resourceId !== expected.resourceId ||
    marker.resourceKey !== expected.resourceKey ||
    marker.resourceKind !== expected.resourceKind ||
    marker.resourceName !== expected.resourceName
  ) {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  return 'owned';
}

export function readPlatformWorkerOwnershipMarker(config: Record<string, unknown>): string {
  const vars = config.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new Error('platform: Platform Worker config is missing its ownership bindings.');
  }
  const marker = (vars as Record<string, unknown>).PLATFORM_OWNERSHIP_MARKER;
  if (typeof marker !== 'string' || marker === '') {
    throw new Error('platform: Platform Worker config is missing its ownership marker.');
  }
  return marker;
}

export async function readActivePlatformWorkerSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
  unrecordedTriggerConfig?: CloudflareTriggerConfig,
): Promise<{
  contentHash?: string;
  migrationTag: string | null;
  triggerConfig: CloudflareTriggerConfig;
  versionId: string;
}> {
  const readActiveVersion = () =>
    readActivePlatformWorkerVersion(configPath, accountId, workerName, runner);
  const versionId = await readActiveVersion();
  if (!versionId) {
    throw new Error(
      `platform: Existing Worker ${workerName} has no single active production version.`,
    );
  }
  const snapshot = await readPlatformWorkerVersionSnapshot(
    configPath,
    accountId,
    workerName,
    expectedOwnershipMarker,
    versionId,
    runner,
    async () => {
      if ((await readActiveVersion()) !== versionId) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its active version was inspected.`,
        );
      }
    },
    unrecordedTriggerConfig,
  );
  return snapshot;
}

export async function readPlatformWorkerVersionSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  versionId: string,
  runner: typeof runPlatformWrangler,
  validateCurrentVersion?: () => Promise<void>,
  unrecordedTriggerConfig?: CloudflareTriggerConfig,
): Promise<Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>> {
  const result = await runner(
    { type: 'versions.view', versionId, configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  assertCleanPlatformWrangler(result, `read rollback metadata for ${workerName}`, accountId);
  const value = result.data;
  if (!value || typeof value !== 'object') {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  const resources = (value as { resources?: unknown }).resources;
  const bindings =
    resources && typeof resources === 'object' && !Array.isArray(resources)
      ? (resources as { bindings?: unknown }).bindings
      : null;
  const ownershipBindings = Array.isArray(bindings)
    ? bindings.filter(
        (binding) =>
          binding &&
          typeof binding === 'object' &&
          (binding as { name?: unknown }).name === 'PLATFORM_OWNERSHIP_MARKER' &&
          (binding as { type?: unknown }).type === 'plain_text' &&
          typeof (binding as { text?: unknown }).text === 'string',
      )
    : [];
  if (
    ownershipBindings.length !== 1 ||
    (ownershipBindings[0] as { text: string }).text !== expectedOwnershipMarker
  ) {
    throw new PlatformWorkerOwnershipError(
      `platform: Active Worker version ${versionId} for ${workerName} does not belong to this installation.`,
    );
  }
  await validateCurrentVersion?.();
  const annotations = (value as { annotations?: unknown }).annotations;
  const message =
    annotations &&
    typeof annotations === 'object' &&
    typeof (annotations as Record<string, unknown>)['workers/message'] === 'string'
      ? ((annotations as Record<string, string>)['workers/message'] ?? null)
      : null;
  const metadata = parseCloudflareVersionMessage(message);
  // A version made outside Void has no Void record of its triggers. Only a run
  // that replaces those changes, with the operator's consent, gives Void's own.
  if (metadata?.schema !== 2 && unrecordedTriggerConfig) {
    return {
      migrationTag: readCloudflareVersionMigrationTag(value),
      triggerConfig: unrecordedTriggerConfig,
      versionId,
    };
  }
  if (metadata?.schema !== 2) {
    throw new Error(
      `platform: Active Worker ${workerName} predates safe trigger snapshots. Refusing to upgrade because its routes, cron, and queue consumers could not be restored after a failed cutover.`,
    );
  }
  const migrationTag = readCloudflareVersionMigrationTag(value);
  return {
    ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
    migrationTag,
    triggerConfig: metadata.triggerConfig,
    versionId,
  };
}
