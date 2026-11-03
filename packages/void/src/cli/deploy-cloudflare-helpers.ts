import { existsSync } from 'node:fs';
import {
  activateCloudflareVersion,
  assertCloudflareBindingsPreserved,
  parseRootWranglerConfig,
  readExistingCloudflareWorker,
  readWranglerTopLevelString,
  type ApprovedCloudflareKvBinding,
  type CloudflareCommandRunner,
  type ExistingCloudflareWorker,
} from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { materializeCloudflareConfig } from '../cloudflare-config.ts';
import { trustedCloudflareWorkerAccessHeaders } from '../shared/cf-access.ts';
import type { CfBuildOutput } from './cf-build-output.ts';
import {
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
} from './cf-version-runner.ts';
import {
  CloudflareAuthenticationError,
  ensureCloudflareAuthentication,
} from './cloudflare-auth.ts';
import {
  assertCloudflareCandidateUnchanged,
  clearCloudflareCandidate,
  recordCloudflareCandidateUpload,
  type CloudflareCandidateReceipt,
} from './cloudflare-candidate.ts';
import {
  assertCloudflareLinkUnchanged,
  completeCloudflareLink,
  recordCloudflareCandidate,
  type CloudflareLink,
} from './cloudflare-link.ts';
import {
  createCloudflareEmptyCronPublisher,
  createCloudflareEmptyDomainPublisher,
} from './cloudflare-operations.ts';
import {
  readCloudflareWorkersDevSubdomain,
  rememberCloudflareWorkersDevSubdomain,
  resolveCloudflareReadinessAccessOrigin,
  resolveCloudflareWorkersDevSubdomain,
} from './cloudflare-readiness.ts';
import {
  assertWranglerUploaderUnchanged,
  hashCfUploader,
  hashWranglerUploader,
} from './deploy-binding-snapshot.ts';
import {
  chooseCloudflareDeployAccount,
  createDeployWranglerRunner,
  runWranglerAuthToken,
} from './deploy-cloudflare-auth.ts';
import { log } from './deploy-helpers.ts';
import { deployChildEnv, resolveDeployTransport } from './deploy-transport.ts';
import type { CloudflareDeployDeps, DeployWranglerRun } from './deploy-types.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner, getErrorMessage } from './output.ts';
import { resolveWorkersDevComplianceRegion, type ComplianceRegion } from './provision.ts';
import {
  acknowledgeWranglerManagedQueueRemovals,
  readWranglerPublishedTrafficSnapshot,
  writeWranglerPublishedTrafficSnapshot,
  type readWranglerManagedQueueCleanupCandidates,
} from './wrangler.ts';

type CloudflareActivationOptions = Parameters<typeof activateCloudflareVersion>[0];
type CloudflareActivationResult = Awaited<ReturnType<typeof activateCloudflareVersion>>;

/**
 * Discover the root wrangler config path the same way the build / bindings
 * writer do (wrangler.jsonc first, then wrangler.json). Falls back to the
 * default wrangler.jsonc path when none exists yet — the provisioner creates it.
 */
export function discoverRootWranglerConfig(root: string): string {
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment needs one root wrangler.jsonc or wrangler.json with the same settings. Convert the config before deploying.',
    );
  }
  return materializeCloudflareConfig(root);
}

/**
 * Pin both uploaders before the first authenticated command. Every later credentialed run
 * checks the same baseline, so project code can never swap the executable under the session.
 * Injected test runners (`activateVersion` / `runWrangler`) bypass the pinned cf uploader.
 */
function createCloudflareUploaderPins(
  root: string,
  deps: CloudflareDeployDeps,
): {
  usesCf: boolean;
  cfUploaderIsPinned: () => boolean;
  assertUploaderStillPinned: () => boolean;
} {
  const usesCf = !deps.activateVersion && !deps.runWrangler;
  const hashUploader = deps.hashWranglerUploader ?? hashWranglerUploader;
  const wranglerUploaderHashBefore = hashUploader(root);
  const cfUploaderHashBefore = usesCf ? hashCfUploader() : undefined;
  return {
    usesCf,
    cfUploaderIsPinned: () => {
      const matched =
        cfUploaderHashBefore !== undefined && cfUploaderHashBefore === hashCfUploader();
      if (!matched) {
        log.error('deploy: refusing to run a changed cf uploader with Cloudflare credentials.');
      }
      return matched;
    },
    assertUploaderStillPinned: () => {
      const check = assertWranglerUploaderUnchanged(wranglerUploaderHashBefore, hashUploader(root));
      if (!check.ok) {
        log.error(
          [
            'deploy: refusing to run the Cloudflare uploader with your Cloudflare credentials.',
            check.reason,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      return check.ok;
    },
  };
}

/** Log a failed Cloudflare sign-in. An uploader change has already reported itself. */
function logCloudflareAuthFailure(error: unknown): void {
  if (!(error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed')) {
    log.error(`deploy: ${getErrorMessage(error)}`);
  }
}

type CloudflareDeployConnection = {
  apiBaseUrl: string;
  /** The workers.dev region, pinned with the API base. Undefined if it does not resolve. */
  complianceRegion: ComplianceRegion | undefined;
  usesCf: boolean;
  cfUploaderIsPinned: () => boolean;
  assertUploaderStillPinned: () => boolean;
  accountId: string;
  workersDevSubdomain: string | undefined;
  /** Validated operator origin that may receive readiness Access credentials. */
  readinessAccessOrigin: string | undefined;
  runWrangler: DeployWranglerRun;
  /** The root config, read again after a first-run account choice. */
  rootConfig: Record<string, unknown>;
};

/**
 * Pin the transport, the uploaders and the account, then create the deploy runner. A first
 * deploy without an account signs in and chooses one. Logs and returns null on failure.
 */
export async function connectCloudflareDeployAccount(options: {
  root: string;
  configPath: string;
  rootConfig: Record<string, unknown>;
  deps: CloudflareDeployDeps;
  persistAccount: boolean;
  /** `CF_ACCESS_READINESS_ORIGIN` as recorded before project code ran. */
  readinessAccessOrigin: string | null | undefined;
}): Promise<CloudflareDeployConnection | null> {
  const { root, configPath, deps } = options;
  let { rootConfig } = options;
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (error) {
    log.error(`deploy: ${getErrorMessage(error)}`);
    return null;
  }
  // Pin the region from the same inputs, before project code can edit the root config.
  const complianceRegion = resolveWorkersDevComplianceRegion(
    process.env,
    readWranglerTopLevelString(rootConfig, 'compliance_region'),
  );
  // Pin the uploaders before the first authenticated command, including account discovery.
  const pins = createCloudflareUploaderPins(root, deps);
  let accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    const accountRunner =
      deps.runWrangler ?? createDeployWranglerRunner(root, undefined, apiBaseUrl);
    try {
      accountId = await chooseCloudflareDeployAccount({
        persist: options.persistAccount,
        beforeWranglerRun: pins.assertUploaderStillPinned,
        configPath,
        root,
        runWrangler: accountRunner,
      });
      rootConfig = parseRootWranglerConfig(configPath);
    } catch (error) {
      logCloudflareAuthFailure(error);
      return null;
    }
  }
  let workersDevSubdomain: string | undefined;
  let readinessAccessOrigin: string | undefined;
  try {
    workersDevSubdomain = resolveCloudflareWorkersDevSubdomain(root, accountId);
    // Reject an invalid opt-in before the build.
    readinessAccessOrigin = resolveCloudflareReadinessAccessOrigin({
      CF_ACCESS_READINESS_ORIGIN: options.readinessAccessOrigin ?? undefined,
    });
  } catch (error) {
    log.error(getErrorMessage(error));
    return null;
  }
  return {
    ...pins,
    apiBaseUrl,
    complianceRegion,
    accountId,
    workersDevSubdomain,
    readinessAccessOrigin,
    runWrangler: deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl),
    rootConfig,
  };
}

/** Confirm the Cloudflare session through the pinned uploader. Logs and returns false on failure. */
export async function confirmCloudflareDeployAuthentication(
  connection: Pick<CloudflareDeployConnection, 'runWrangler' | 'assertUploaderStillPinned'>,
  configPath: string,
): Promise<boolean> {
  if (!connection.assertUploaderStillPinned()) {
    return false;
  }
  try {
    await ensureCloudflareAuthentication({
      acceptApiToken: true,
      beforeRun: connection.assertUploaderStillPinned,
      runWrangler: (operation, capture) => connection.runWrangler(operation, { capture }),
      configPath: existsSync(configPath) ? configPath : undefined,
    });
    return true;
  } catch (error) {
    logCloudflareAuthFailure(error);
    return false;
  }
}

/** Fail before upload when the handoff link or saved candidate no longer matches this deploy. */
export function assertCloudflareDeployTargetUnchanged(options: {
  root: string;
  existingWorker: ExistingCloudflareWorker | null;
  pinnedHandoffLink: CloudflareLink | null;
  initialCloudflareCandidate: CloudflareCandidateReceipt | null;
  accountId: string;
  workerName: string;
}): void {
  const { root, initialCloudflareCandidate: candidate } = options;
  if (options.existingWorker) {
    assertCloudflareLinkUnchanged(root, options.pinnedHandoffLink);
  }
  assertCloudflareCandidateUnchanged(root, candidate);
  if (
    candidate &&
    (candidate.accountId !== options.accountId || candidate.workerName !== options.workerName)
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different account or Worker. Inspect its receipt before retrying.',
    );
  }
}

/** Route activation through the pinned cf uploader, or the injected runner when there is no cf output. */
export function createCfActivationRunner(options: {
  cfOutput: CfBuildOutput | null;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  configPath: string;
  runWrangler: DeployWranglerRun;
  cfUploaderIsPinned: () => boolean;
  verifyCompatibilityRunner: () => boolean;
}): CloudflareCommandRunner | DeployWranglerRun {
  const { cfOutput, accountId, apiBaseUrl, configPath, runWrangler } = options;
  if (!cfOutput) {
    return runWrangler;
  }
  const runCf = createCfCommand({
    accountId,
    apiBaseUrl,
    env: deployChildEnv,
    verifyUploader: options.cfUploaderIsPinned,
  });
  return createCfVersionRunner({
    output: cfOutput,
    workerName: options.workerName,
    runCf,
    pinnedUpload: {
      accountId,
      apiBaseUrl,
      getToken: () => runWranglerAuthToken(runWrangler, configPath),
      verifyUploader: options.cfUploaderIsPinned,
    },
    verifyResources: createCfResourceVerifier({
      configPath,
      runCf,
      runWrangler,
      verifyCompatibilityRunner: options.verifyCompatibilityRunner,
    }),
  });
}

/**
 * Activation options shared by the Worker and static deploys: candidate tracking, the uploaded
 * binding check, readiness probing and trigger cleanup.
 */
export function cloudflareCandidateActivationOptions(options: {
  root: string;
  /** Root config, read for the last published traffic state. */
  rootConfigPath: string;
  /** Config the version is uploaded from. */
  uploadConfigPath: string;
  accountId: string;
  apiBaseUrl: string;
  /** The workers.dev region that the connection pinned. Undefined if it did not resolve. */
  complianceRegion: ComplianceRegion | undefined;
  workerName: string;
  workersDevSubdomain: string | undefined;
  /** Validated operator origin from the deploy connection. */
  readinessAccessOrigin: string | undefined;
  runWrangler: DeployWranglerRun;
  readExistingWorker: CloudflareDeployDeps['readExistingWorker'];
  existingWorker: ExistingCloudflareWorker | null;
  pinnedHandoffLink: CloudflareLink | null;
  initialCloudflareCandidate: CloudflareCandidateReceipt | null;
  assertUploaderStillPinned: () => boolean;
  approvedKv: ReadonlyArray<ApprovedCloudflareKvBinding>;
  staticAssetsBinding?: string;
  queueConsumerCleanup: ReturnType<typeof readWranglerManagedQueueCleanupCandidates>;
}): Omit<
  CloudflareActivationOptions,
  | 'runWrangler'
  | 'verifyUploader'
  | 'message'
  | 'requireVersionMetadata'
  | 'requirePreviewForReadiness'
> {
  const { root, accountId, workerName, workersDevSubdomain, runWrangler, existingWorker } = options;
  const { pinnedHandoffLink, initialCloudflareCandidate } = options;
  const configPath = options.uploadConfigPath;
  const candidateReceipt = pinnedHandoffLink?.candidateReceipt;
  return {
    workerName,
    configPath,
    preserveTriggers: existingWorker !== null,
    expectedPreviousVersionId: existingWorker?.versionId,
    trustedInheritanceVersionIds: existingWorker
      ? candidateReceipt?.parentVersionId === existingWorker.versionId
        ? candidateReceipt.versionIds
        : undefined
      : initialCloudflareCandidate?.versionIds,
    validateUploadedVersion: existingWorker
      ? async (versionId) => {
          if (!options.assertUploaderStillPinned()) {
            throw new Error('The deployment uploader changed.');
          }
          const uploaded = await (options.readExistingWorker ?? readExistingCloudflareWorker)({
            runWrangler,
            configPath,
            workerName,
            versionId,
          });
          assertCloudflareBindingsPreserved(existingWorker, uploaded, options.approvedKv, {
            staticAssetsBinding: options.staticAssetsBinding,
          });
        }
      : undefined,
    recordVerifiedCandidate: existingWorker
      ? (versionId) =>
          recordCloudflareCandidate(root, pinnedHandoffLink!, existingWorker.versionId, versionId)
      : (versionId, parentVersionId) => {
          if (parentVersionId) {
            recordCloudflareCandidateUpload(
              root,
              initialCloudflareCandidate,
              accountId,
              workerName,
              parentVersionId,
              versionId,
            );
          }
        },
    readinessHeaders: cloudflareWorkerReadinessHeaders(),
    workersDevSubdomain,
    resolveWorkersDevSubdomain: async () => {
      const { complianceRegion } = options;
      // Without a region, the host is unknown. Do not guess one.
      if (complianceRegion === undefined) {
        return { ok: false, reason: 'unavailable' };
      }
      return readCloudflareWorkersDevSubdomain({
        configPath,
        complianceRegion,
        runWrangler,
        verifyUploader: options.assertUploaderStillPinned,
      });
    },
    readinessHeadersWorkersDevSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim()
      ? workersDevSubdomain
      : undefined,
    readinessHeadersOrigin: options.readinessAccessOrigin,
    ...createCloudflareEmptyTriggerPublishers({
      accountId,
      apiBaseUrl: options.apiBaseUrl,
      configPath,
      workerName,
      runWrangler,
    }),
    previousTrafficConfig: readWranglerPublishedTrafficSnapshot(options.rootConfigPath),
    queueConsumerCleanup: options.queueConsumerCleanup,
    verifyInheritedSecrets: true,
  };
}

/** Activation callbacks that clear custom domains and crons when the config removes them. */
function createCloudflareEmptyTriggerPublishers(options: {
  accountId: string;
  apiBaseUrl: string;
  configPath: string;
  workerName: string;
  runWrangler: DeployWranglerRun;
}): {
  publishEmptyCustomDomains: ReturnType<typeof createCloudflareEmptyDomainPublisher>;
  publishEmptyCrons: ReturnType<typeof createCloudflareEmptyCronPublisher>;
} {
  return {
    publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(options),
    publishEmptyCrons: createCloudflareEmptyCronPublisher(options),
  };
}

/** Persist the local state that follows a successful activation. */
export function recordCloudflareActivation(options: {
  root: string;
  configPath: string;
  accountId: string;
  workerName: string;
  existingWorker: ExistingCloudflareWorker | null;
  queueConsumerCleanup: ReturnType<typeof readWranglerManagedQueueCleanupCandidates>;
  execution: Extract<CloudflareActivationResult, { ok: true }>;
  cliLog: CliLogger;
}): void {
  const { root, configPath, execution } = options;
  clearCloudflareCandidate(root);
  if (options.existingWorker) {
    completeCloudflareLink(root);
  }
  acknowledgeWranglerManagedQueueRemovals(configPath, options.queueConsumerCleanup);
  rememberCloudflareWorkersDevSubdomain(root, options.accountId, execution.previewUrl);
  if (execution.trafficConfig) {
    writeWranglerPublishedTrafficSnapshot(
      configPath,
      {
        workers_dev: execution.trafficConfig.workers_dev,
        preview_urls: execution.trafficConfig.preview_urls,
        routes: [...execution.trafficConfig.routes],
      },
      { create: false },
    );
  }
  options.cliLog.info('cloudflare_deploy_end', {
    ok: true,
    worker: options.workerName,
    versionId: execution.versionId,
  });
}

export async function reportCloudflareActivationFailure(
  cliLog: CliLogger,
  message: string,
): Promise<void> {
  cliLog.error('cloudflare_deploy_failed', new Error(message));
  // The default exit() terminates the process immediately, so flush the diagnostic first.
  await cliLog.close().catch(() => {});
  log.error(`${message}${cliLog.path ? `\n\nDetailed log: ${cliLog.path}` : ''}`);
}

export async function activateCloudflareVersionWithProgress(
  activate: typeof activateCloudflareVersion,
  options: Parameters<typeof activateCloudflareVersion>[0],
): ReturnType<typeof activateCloudflareVersion> {
  const progress = createSpinner();
  progress.start('Checking the current Worker deployment...');
  try {
    const result = await activate({
      ...options,
      onProgress: (message) => progress.message(message),
    });
    if (result.ok) {
      progress.clear();
    } else {
      progress.error('Worker deployment stopped.');
    }
    return result;
  } catch (error) {
    progress.error('Worker deployment stopped.');
    throw error;
  }
}

export function formatCloudflareActivationError(
  result: Exclude<CloudflareActivationResult, { ok: true }>,
): string {
  const message = formatCloudflareActivationFailure(result);
  return result.restoredOlderSecrets
    ? `${message}\nCloudflare refused to restore the previous version because this deploy changed a secret, so Void forced the restore. The previous version runs with its old secret values; deploy again to apply the new ones.`
    : message;
}

function formatCloudflareActivationFailure(
  result: Exclude<CloudflareActivationResult, { ok: true }>,
): string {
  const status = result.status === undefined ? '' : ` (exit ${String(result.status)})`;
  const cloudflareCode =
    result.cloudflareErrorCode === undefined
      ? ''
      : ` Cloudflare error code: ${String(result.cloudflareErrorCode)}.`;
  const diagnostic = result.diagnostic ? `\n\n${result.diagnostic}` : '';
  switch (result.reason) {
    case 'uploader-changed':
      if (result.rollback === 'succeeded') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Traffic was restored to the previous version.';
      }
      if (result.rollback === 'unavailable') {
        return 'deploy: the verified Wrangler uploader changed after the first version activated. No previous version is available; inspect `void project status` immediately.';
      }
      if (result.rollback === 'failed') {
        return 'deploy: the verified Wrangler uploader changed after version activation, and automatic traffic restoration failed. Inspect `void project status` immediately.';
      }
      if (result.rollback === 'unsafe') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Void did not invoke the changed binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
      }
      return 'deploy: the verified Wrangler uploader changed before version activation.';
    case 'status-failed':
      if (result.versionId) {
        return `deploy: Worker version ${result.versionId} was published, but current deployment status could not be verified${status}. Inspect \`void project status\` before retrying.`;
      }
      return `deploy: could not snapshot the current Cloudflare deployment${status}; no version was uploaded.`;
    case 'deployment-changed':
      return result.triggerRepair === 'succeeded'
        ? `deploy: another Cloudflare operation superseded this deployment. Void restored triggers for the active version ${result.activeVersionId ?? '(unknown)'}; retry from fresh deployment status.`
        : `deploy: another Cloudflare operation superseded this deployment, but its trigger state could not be verified. Inspect the active Worker version ${result.activeVersionId ?? '(unknown)'} immediately.`;
    case 'inheritance-source-unavailable':
      return 'deploy: could not verify which Worker Version would supply inherited secrets; production traffic is unchanged.';
    case 'inheritance-source-changed':
      return [
        'deploy: the active Worker Version is not the latest upload, and its secrets could not be pinned safely.',
        'Inspect the active and latest Worker versions in Cloudflare before retrying.',
        'No version was uploaded; production traffic is unchanged.',
      ].join('\n');
    case 'traffic-preservation-unavailable':
      return [
        'deploy: the existing Worker has dashboard-managed routes or visibility that Void cannot safely republish.',
        'Add its current routes, workers_dev, and preview_urls values to the root Wrangler config, then retry; no version was uploaded.',
      ].join('\n');
    case 'traffic-split-unsupported':
      return [
        'deploy: the current Cloudflare deployment splits traffic across multiple Worker Versions.',
        'Void will not flatten an existing gradual rollout to 100%. Finish or cancel that rollout',
        'in Cloudflare, then retry; no version was uploaded.',
      ].join('\n');
    case 'upload-failed':
      return `deploy: Cloudflare Worker Version upload failed${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}`;
    case 'upload-output-invalid':
      return 'deploy: Wrangler uploaded a version but did not report its version id; production traffic is unchanged.';
    case 'preview-unavailable':
      if (result.diagnostic) {
        return `deploy: candidate readiness cannot be verified.\n\n${result.diagnostic}`;
      }
      return [
        'deploy: the uploaded Worker Version has no preview URL, so Void cannot verify readiness.',
        'Set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain (for example "my-team")',
        'and retry. Void caches it after a successful workers.dev deployment; production traffic is unchanged.',
      ].join('\n');
    case 'readiness-staging-failed': {
      const hint =
        result.cloudflareErrorCode === 10210 &&
        (result.diagnostic ?? '').toLowerCase().includes('durable object migration')
          ? '\n\nReview the Durable Object migration, then run `void deploy --platform cloudflare --atomic`. For future deploys, set deploy.cloudflare.mode to "atomic" in void.config.ts.'
          : result.cloudflareErrorCode === 100405
            ? '\n\nThe new version declares different exports from the live version (for example a Durable Object or Workflow class), so Cloudflare cannot split traffic between them. Run `void deploy --platform cloudflare --atomic` once to publish it at 100% directly; it receives traffic before readiness is checked.'
            : '';
      return `deploy: Cloudflare could not stage the uploaded Worker Version at zero-percent traffic${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}${hint}`;
    }
    case 'atomic-failed':
      return `deploy: Cloudflare could not publish the Worker atomically${status}; inspect production status before retrying.${cloudflareCode}${diagnostic}`;
    case 'atomic-output-invalid':
      if (result.versionId) {
        // An atomic retry publishes through the same bootstrap, which then
        // enables workers.dev during trigger synchronization.
        return formatCloudflarePublishWithoutUrl(
          `Cloudflare published Worker version ${result.versionId} atomically`,
          `If the app uses workers.dev, set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain ${WORKERS_SUBDOMAIN_EXAMPLE}.`,
        );
      }
      return 'deploy: Cloudflare published atomically but did not report its version id. Inspect `void project status` immediately.';
    case 'atomic-readiness-failed':
    case 'atomic-readiness-access-denied': {
      const accessHint = result.customRouteReadinessOrigin
        ? `\n\n${customRouteAccessHint(result.customRouteReadinessOrigin).join('\n')}`
        : '';
      return `deploy: the atomic Worker deployment is live, but /__void/ready could not be verified. Inspect \`void project status\` and Worker logs immediately.${diagnostic}${accessHint}`;
    }
    case 'readiness-failed':
      return [
        'deploy: the uploaded Worker Version did not pass /__void/ready.',
        formatCloudflareReadinessRestoration(result),
      ].join('\n');
    case 'readiness-access-denied':
      if (result.customRouteReadinessOrigin) {
        return [
          'deploy: Cloudflare Access blocked the uploaded Worker Version readiness probe.',
          ...customRouteAccessHint(result.customRouteReadinessOrigin),
          ATOMIC_ACCESS_ALTERNATIVE,
          formatCloudflareReadinessRestoration(result),
        ].join('\n');
      }
      return [
        'deploy: Cloudflare Access blocked the uploaded Worker Version readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token.',
        'For a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        `Then retry. ${formatCloudflareReadinessRestoration(result)}`,
      ].join('\n');
    case 'bootstrap-failed':
      return `deploy: Cloudflare could not bootstrap the first Worker deployment${status}.${cloudflareCode}${diagnostic}`;
    case 'bootstrap-output-invalid':
      if (result.versionId) {
        // A non-atomic retry stages the next version behind the workers.dev
        // URL, which stays off until a trigger synchronization succeeds.
        return formatCloudflarePublishWithoutUrl(
          `Cloudflare published the first Worker deployment as version ${result.versionId}`,
          `If the app uses workers.dev, enable workers.dev for this Worker in the Cloudflare dashboard. Then set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain ${WORKERS_SUBDOMAIN_EXAMPLE}.`,
        );
      }
      return [
        'deploy: Cloudflare bootstrapped the first Worker deployment, but Wrangler',
        'did not report its version id. Inspect `void project status` before retrying.',
      ].join('\n');
    case 'bootstrap-readiness-failed':
      return (
        [
          'deploy: the first Worker deployment did not pass /__void/ready.',
          'Cloudflare requires this bootstrap to be non-versioned, so the new Worker is already active;',
          'inspect its logs and `void project status` before retrying.',
        ].join('\n') + diagnostic
      );
    case 'bootstrap-readiness-access-denied':
      if (result.customRouteReadinessOrigin) {
        return [
          'deploy: Cloudflare Access blocked the first Worker deployment readiness probe.',
          'Cloudflare requires the first deployment to be non-versioned, so the new Worker is already active behind Access.',
          ...customRouteAccessHint(result.customRouteReadinessOrigin),
          'Later deploys check readiness before traffic moves, so they need the same setting.',
          ATOMIC_ACCESS_ALTERNATIVE,
        ].join('\n');
      }
      return [
        'deploy: Cloudflare Access blocked the first Worker deployment readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token;',
        'for a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        'Then retry. Cloudflare requires the first deployment to be non-versioned, so the new',
        'Worker is already active behind Access.',
      ].join('\n');
    case 'activation-failed':
      return `deploy: the ready Worker Version could not be activated${status}; production traffic is unchanged.`;
    case 'triggers-failed': {
      const rollback =
        result.rollback === 'succeeded'
          ? 'Traffic was restored to the previous version.'
          : result.rollback === 'unavailable'
            ? result.previousVersionId === null
              ? 'This was the first deployment, so no previous version was available to restore.'
              : 'Traffic or trigger restoration could not be completed. Inspect its routes, schedules, queues, and workflows in Cloudflare before retrying.'
            : 'Automatic traffic restoration failed; inspect `void project status` immediately.';
      return `deploy: the Worker activated, but Cloudflare trigger synchronization failed${status}. ${rollback}`;
    }
  }
}

/** Explain why a custom-route readiness probe carried no Access credentials. */
function customRouteAccessHint(origin: string): Array<string> {
  return [
    `Void did not send Access credentials to ${origin}. A route or Custom Domain receives them only when CF_ACCESS_READINESS_ORIGIN names its origin.`,
    `If Access protects ${origin} and admits your credentials, set CF_ACCESS_READINESS_ORIGIN=${origin} with CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or CF_ACCESS_TOKEN. Then retry.`,
    'Set it only if you control this hostname and it serves this Worker, because Void sends your Access credentials to it.',
  ];
}

const ATOMIC_ACCESS_ALTERNATIVE =
  'For a Worker with Durable Object migration history, `void deploy --platform cloudflare --atomic` publishes without the zero-traffic check. The new version receives traffic first, and the command still exits with an error because Void cannot verify readiness through Access.';

function formatCloudflareReadinessRestoration(
  result: Exclude<CloudflareActivationResult, { ok: true }>,
): string {
  switch (result.rollback) {
    case 'succeeded':
      return 'The failed version remains inactive, and traffic was restored to the previous version.';
    case 'failed':
      return 'Automatic traffic restoration failed; inspect `void project status` immediately.';
    case 'unsafe':
      return 'Void did not invoke the changed Wrangler binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
    case 'unavailable':
      return 'No previous version was available to restore; inspect `void project status` immediately.';
    default:
      return 'The failed version remains inactive for inspection; production traffic is unchanged.';
  }
}

const WORKERS_SUBDOMAIN_EXAMPLE = '(for example "my-team", or "my-team.fed" for FedRAMP High)';

/** Explain a live version whose readiness URL Void could not determine. */
function formatCloudflarePublishWithoutUrl(published: string, recovery: string): string {
  return [
    `deploy: ${published}, but Void could not determine its URL.`,
    'Void did not update its routes, workers.dev setting, or other triggers, and did not check /__void/ready.',
    recovery,
    'Then inspect `void project status` before you deploy again.',
  ].join('\n');
}

/** Capture the Access credential used only by the guarded Worker readiness probe. */
function cloudflareWorkerReadinessHeaders(): Record<string, string> {
  return trustedCloudflareWorkerAccessHeaders({
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
    CF_ACCESS_TOKEN: process.env.CF_ACCESS_TOKEN,
  });
}
