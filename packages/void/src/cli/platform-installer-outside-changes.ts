import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformInstallationManifest } from '@void/platform';
import type { PlatformRuntime } from '@void/platform/installer';
import { confirm, isCancel, log, type SpinnerResult } from '@voidzero-dev/vite-plus-prompts';
import { note } from './output.ts';
import {
  PlatformCloudflareApiError,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import {
  interruptedWorkerCutover,
  workerCutoverUpdatesSecrets,
} from './platform-installer-cutover.ts';
import {
  platformWorkerVersionHasTriggerRecord,
  readActivePlatformWorkerDeployment,
} from './platform-installer-inspection.ts';
import { runPlatformWranglerAtApiBase } from './platform-installer-process.ts';
import type {
  PlatformDatabaseLifecycleLock,
  PlatformWorkerKey,
} from './platform-installer-types.ts';
import {
  platformWorkerResourceKey,
  uploadPlatformWorkerForReview,
  type runPlatformWrangler,
} from './platform-installer-workers.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

const OUTSIDE_SOURCES = {
  // The Cloudflare CLI asks before it uploads a Worker last changed from one of
  // these sources. Without a terminal it stops the upload, and no option skips that.
  dash: 'changed in the Cloudflare dashboard',
  api: 'changed in the Cloudflare API',
  // The upgrade refuses an active version without Void's record of its
  // triggers. A run can stop after the Cloudflare CLI replaced a change and
  // before Void deployed its own version, or restore the earlier version.
  // The Worker then shows no change, but that version stays active. Void
  // releases before the record deployed versions without it too.
  unrecorded: 'has an active version without a Void deployment record',
} as const;

const PLATFORM_WORKER_KEYS: ReadonlyArray<PlatformWorkerKey> = [
  'api',
  'proxy',
  'emailGateway',
  'tail',
  'dispatch',
];

// The lifecycle lock can change the database before this check. The check
// itself changes no Worker and does not pause traffic.
const NO_WORKER_CHANGED =
  'No platform Worker changed. This command did not pause application traffic.';

/** The wait before the second and the third read of a Worker. */
const READ_RETRY_DELAYS_MS = [250, 500] as const;

/** Stop before the run changes a Worker, because Void cannot tell what the run replaces. */
function unreadablePlatformWorker(workerName: string, error: unknown): Error {
  const status = error instanceof PlatformCloudflareApiError ? error.status : null;
  const answer =
    status === null
      ? `no HTTP response: ${error instanceof Error ? error.message : String(error)}`
      : `HTTP ${status}`;
  return new Error(
    [
      `platform: Void cannot read the platform Worker ${workerName} (${answer}), so it cannot find changes made outside Void.`,
      NO_WORKER_CHANGED,
      status === 401 || status === 403
        ? 'Make sure that the Cloudflare API token has Account → Workers Scripts → Edit for this account. Then run the command again.'
        : 'Run the command again.',
    ].join(' '),
    { cause: error },
  );
}

/**
 * Read a Worker again after a rate limit, a Cloudflare server error or a
 * network failure. Each other failure, or a third failure, stops the run.
 */
async function readPlatformWorker<T>(workerName: string, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const status = error instanceof PlatformCloudflareApiError ? error.status : null;
      const wait = READ_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || (status !== null && status !== 429 && status < 500)) {
        throw unreadablePlatformWorker(workerName, error);
      }
      await delay(wait);
    }
  }
}

export type PlatformWorkerOutsideChange = Readonly<{
  key: PlatformWorkerKey;
  name: string;
  source: keyof typeof OUTSIDE_SOURCES;
}>;

/** The installation that a run continues. */
export type PlatformOutsideChangeInstallation = Readonly<{
  manifest: PlatformInstallationManifest;
  /**
   * The database read that the installer uses. Without it, Void expects the
   * run to restore the earlier versions of a stopped Worker cutover.
   */
  readAuthenticationState?: PlatformDatabaseLifecycleLock['readAuthenticationState'];
}>;

/** The Cloudflare CLI asks only about these changes. The others need no upload for review. */
function needsReviewUpload(change: PlatformWorkerOutsideChange): boolean {
  return change.source !== 'unrecorded';
}

/**
 * The earlier version of each Worker that the installer makes active again
 * before it deploys. A run that stopped during a Worker cutover left Void's
 * version active, and the next run first restores the earlier one. Like the
 * installer, retain rotated credentials or a configurable sign-in transition
 * that already requires sign-in. Every Worker that this check reads exists,
 * so the installation had Workers before.
 */
async function restoredPlatformWorkerVersions(
  installation: PlatformOutsideChangeInstallation,
  runtime: PlatformRuntime,
): Promise<ReadonlyMap<string, string>> {
  const cutover = interruptedWorkerCutover(installation.manifest);
  if (
    !cutover ||
    workerCutoverUpdatesSecrets(installation.manifest, cutover.generation) ||
    (installation.manifest.deployment.authentication.configurable !== true &&
      runtime.manifest.authenticationProtocolVersion === 1 &&
      (await installation.readAuthenticationState?.())?.sessionsRequired === true)
  ) {
    return new Map();
  }
  return new Map(
    [...cutover.staged.values()].flatMap((snapshot) =>
      snapshot.previousVersionId === null
        ? []
        : [[snapshot.workerName, snapshot.previousVersionId] as const],
    ),
  );
}

/** Find the existing platform Workers that a run uploads and that were changed outside Void. */
export async function findPlatformWorkerOutsideChanges(
  client: Pick<PlatformCloudflareClient, 'getWorkerLastDeployedFrom' | 'request'>,
  plan: PlatformInstallPlan,
  runtime: PlatformRuntime,
  installation: PlatformOutsideChangeInstallation,
): Promise<ReadonlyArray<PlatformWorkerOutsideChange>> {
  const workers = PLATFORM_WORKER_KEYS.flatMap((key) => {
    // The installer does not upload an email gateway that the runtime does not include.
    if (key === 'emailGateway' && runtime.manifest.artifacts.emailGateway === undefined) {
      return [];
    }
    const action = plan.actions.find((entry) => entry.key === platformWorkerResourceKey(key));
    return action?.kind === 'worker' && action.action !== 'create'
      ? [{ key, name: action.name }]
      : [];
  });
  const restored =
    workers.length > 0
      ? await restoredPlatformWorkerVersions(installation, runtime)
      : new Map<string, string>();
  const changes = await Promise.all(
    workers.map(async (worker): Promise<PlatformWorkerOutsideChange | null> => {
      // A read that fails stops the run. Without the answer, the run can
      // pause traffic and then fail in the Cloudflare CLI or the upgrade.
      const readCloudflare = (path: string) =>
        readPlatformWorker(worker.name, () => client.request<unknown>(path));
      const source = await readPlatformWorker(worker.name, () =>
        client.getWorkerLastDeployedFrom(plan.account.id, worker.name),
      );
      const deployments = await readPlatformWorker(worker.name, () =>
        client
          .request<unknown>(
            `/accounts/${encodeURIComponent(plan.account.id)}/workers/scripts/${encodeURIComponent(worker.name)}/deployments`,
          )
          .catch((error: unknown) => {
            if (error instanceof PlatformCloudflareApiError && error.status === 404) {
              return null;
            }
            throw error;
          }),
      );
      // No deployments. The installer finds a missing Worker itself, but a
      // marker from outside Void still makes the Cloudflare CLI stop.
      if (deployments === null) {
        return source === 'dash' || source === 'api' ? { ...worker, source } : null;
      }
      const active = readActivePlatformWorkerDeployment(deployments);
      if (active.kind === 'malformed') {
        throw new Error(
          `platform: Cloudflare returned malformed deployment data for the platform Worker ${worker.name}, so Void cannot find changes made outside Void. ${NO_WORKER_CHANGED} Run the command again.`,
        );
      }
      // The deploy and the restore of a stopped cutover need one active version.
      if (active.kind === 'split') {
        throw new Error(
          `platform: The platform Worker ${worker.name} has no single version that gets 100% of traffic, for example after a gradual deployment. This command deploys a new version only when one version gets all traffic. ${NO_WORKER_CHANGED} In the Cloudflare dashboard, deploy one version of ${worker.name} to 100% of traffic. Then run this command once in a terminal, so that you can approve the dashboard change.`,
        );
      }
      if (source === 'dash' || source === 'api') {
        return { ...worker, source };
      }
      // The upgrade reads the active version. After a stopped cutover, the
      // installer first makes the earlier version active again.
      const restoredVersion = restored.get(worker.name);
      const recorded = await Promise.all(
        [active.versionId, ...(restoredVersion === undefined ? [] : [restoredVersion])].map(
          (versionId) =>
            platformWorkerVersionHasTriggerRecord(
              readCloudflare,
              plan.account.id,
              worker.name,
              versionId,
            ),
        ),
      );
      return recorded.includes(false) ? { ...worker, source: 'unrecorded' } : null;
    }),
  );
  return changes.filter((change) => change !== null);
}

function listPlatformWorkerOutsideChanges(
  changes: ReadonlyArray<PlatformWorkerOutsideChange>,
): string {
  return changes.map((change) => `${change.name}: ${OUTSIDE_SOURCES[change.source]}`).join('\n');
}

/**
 * The list of Workers after a heading. The heading must be true for each
 * source: an older Void release can have deployed the active version.
 */
export function formatPlatformWorkerOutsideChanges(
  changes: ReadonlyArray<PlatformWorkerOutsideChange>,
): string {
  return `These platform Workers need your approval before this command replaces their configuration:\n${listPlatformWorkerOutsideChanges(changes)}`;
}

/**
 * Do this before a run changes a Worker or pauses traffic. When platform
 * Workers were changed outside Void, stop, or ask the operator in a terminal.
 * Returns the Workers whose outside changes the operator agreed to replace.
 * The installer uploads them later with uploadPlatformWorkerOutsideChanges.
 */
export async function reviewPlatformWorkerOutsideChanges(
  input: Readonly<{
    client: Pick<PlatformCloudflareClient, 'getWorkerLastDeployedFrom' | 'request'>;
    plan: PlatformInstallPlan;
    runtime: PlatformRuntime;
    installation: PlatformOutsideChangeInstallation;
    /** True only when input and output are a terminal and --yes is not set. */
    interactive: boolean;
    /** The command to run once in a terminal to review the changes. */
    command: string;
  }>,
): Promise<ReadonlyArray<PlatformWorkerOutsideChange>> {
  const changes = await findPlatformWorkerOutsideChanges(
    input.client,
    input.plan,
    input.runtime,
    input.installation,
  );
  if (changes.length === 0) {
    return [];
  }
  if (!input.interactive) {
    throw new Error(
      [
        `platform: ${formatPlatformWorkerOutsideChanges(changes)}`,
        NO_WORKER_CHANGED,
        'This command replaces their configuration with the Void configuration. It can ask for your approval only in a terminal.',
        `Run this command once in a terminal to review them:\n${input.command}`,
      ].join('\n'),
    );
  }
  note(
    [
      listPlatformWorkerOutsideChanges(changes),
      '',
      'This command replaces the configuration of these Workers with the Void configuration.',
      'It removes values that Void does not set, for example an EMAIL_FROM that you added.',
      'It resets values that Void sets, for example AUTH_REDIRECT_URI.',
      ...(changes.some(needsReviewUpload)
        ? [
            'First, it prepares the platform resources and the database.',
            'Then, before it pauses traffic or deploys a Worker, the Cloudflare CLI asks you again for each Worker changed in the Cloudflare dashboard or API. For a dashboard change, it shows the differences.',
            'It uploads a new version of each of these Workers and does not deploy it.',
          ]
        : []),
    ].join('\n'),
    'Approval needed',
  );
  const answer = await confirm({
    message: 'Replace the configuration of these Workers?',
    initialValue: false,
  });
  if (isCancel(answer) || typeof answer === 'symbol' || !answer) {
    throw new Error(`platform: Cancelled. ${NO_WORKER_CHANGED}`);
  }
  return changes;
}

/**
 * Upload a new version of each Worker that the operator agreed to replace, and
 * do not deploy it. The installer gives the configs after it creates the
 * resources that they use, and before it pauses traffic. The Cloudflare CLI
 * uses this terminal: it shows what the upload replaces and asks the operator.
 */
export async function uploadPlatformWorkerOutsideChanges(
  configs: ReadonlyArray<Record<string, unknown>>,
  input: Readonly<{
    /** The changes that the operator agreed to replace. */
    changes: ReadonlyArray<PlatformWorkerOutsideChange>;
    client: Pick<PlatformCloudflareClient, 'apiBaseUrl' | 'getWorkerLastDeployedFrom' | 'request'>;
    operatorApiToken: string;
    /** It stops while the Cloudflare CLI uses the terminal, so it cannot write over the question. */
    progress?: Pick<SpinnerResult, 'pause' | 'resume'>;
    runner?: typeof runPlatformWrangler;
  }>,
): Promise<void> {
  const { client } = input;
  const reviewed = configs.filter((config) =>
    input.changes.some((change) => change.name === config.name && needsReviewUpload(change)),
  );
  if (reviewed.length === 0) {
    return;
  }
  const runner: typeof runPlatformWrangler =
    input.runner ??
    ((operation, accountId, cwd, capture) =>
      runPlatformWranglerAtApiBase(
        operation,
        accountId,
        cwd,
        capture,
        client.apiBaseUrl,
        false,
        input.operatorApiToken,
      ));
  input.progress?.pause();
  try {
    for (const config of reviewed) {
      const name = String(config.name);
      log.step(`Uploading a new version of ${name} without deploying it`);
      const uploaded = await uploadPlatformWorkerForReview(config, {
        readCloudflare: (path) => client.request(path),
        runner,
      });
      // A refused upload can still exit with status 0, so read the source again.
      const source = await client.getWorkerLastDeployedFrom(String(config.account_id), name);
      if (uploaded.status !== 0 || source === 'dash' || source === 'api') {
        throw new Error(
          `platform: The Cloudflare CLI did not replace the changes to ${name}. Its output above shows why. No deployment changed. This command did not pause application traffic.`,
        );
      }
    }
  } finally {
    input.progress?.resume();
  }
}
