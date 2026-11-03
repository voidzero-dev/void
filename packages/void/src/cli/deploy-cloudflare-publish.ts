import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import { detectFramework } from '../plugin-inference.ts';
import { readVersionMetadataBinding } from '../shared/version-metadata.ts';
import { createActiveSecretPinner } from './cf-version-runner.ts';
import {
  clearCloudflareCandidate,
  type CloudflareCandidateReceipt,
} from './cloudflare-candidate.ts';
import type { CloudflareBuild } from './deploy-cloudflare-build.ts';
import {
  activateCloudflareVersionWithProgress,
  assertCloudflareDeployTargetUnchanged,
  cloudflareCandidateActivationOptions,
  createCfActivationRunner,
  recordCloudflareActivation,
  reportCloudflareActivationFailure,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import type { CloudflareMigration } from './deploy-cloudflare-migrate.ts';
import type { CloudflareDeploySource, CloudflarePreflight } from './deploy-cloudflare-preflight.ts';
import { log } from './deploy-helpers.ts';
import { formatCloudflareSandboxUnavailable, BETTER_AUTH_SECRET_NAME } from './deploy-resources.ts';
import { formatDeploySummary } from './deploy-summary.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type CliLogger } from './log-file.ts';
import { note } from './output.ts';
import { readWranglerManagedQueueCleanupCandidates } from './wrangler.ts';

/** Upload the verified Worker as a candidate version, probe it, and activate it. */
export async function publishCloudflareWorker(input: {
  readonly root: string;
  readonly deps: CloudflareDeployDeps;
  readonly exit: (code: number) => never;
  readonly cliLog: CliLogger;
  readonly atomic: boolean;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
  readonly initialCloudflareCandidate: CloudflareCandidateReceipt | null;
  readonly source: CloudflareDeploySource;
  readonly preflight: CloudflarePreflight;
  readonly build: CloudflareBuild;
  readonly migration: CloudflareMigration;
}): Promise<void> {
  const { root, deps, exit, cliLog, atomic, detectedFramework, initialCloudflareCandidate } = input;
  const { configPath, needsSandbox, desired, analysis } = input.source;
  const {
    usesCf,
    existingWorker,
    pinnedHandoffLink,
    accountId,
    workerName,
    cfUploaderIsPinned,
    apiBaseUrl,
    complianceRegion,
    runWrangler,
    assertUploaderStillPinned,
    schemaFacts,
    approvedHandoffKv,
    workersDevSubdomain,
    readinessAccessOrigin,
  } = input.preflight;
  const { migrations, d1MigrateToken, generatedConfigPath, prepareBuildOutput } = input.build;
  const { workerWasMissingBeforeSecretProvisioning, initialAuthSecret, appliedMigrations } =
    input.migration;

  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  assertCloudflareDeployTargetUnchanged({
    root,
    existingWorker,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
  });
  if (usesCf && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = usesCf ? await prepareBuildOutput() : null;
  if (!cfOutput && usesCf) {
    log.error('deploy: cf could not prepare the built Worker for deployment.');
    return exit(1);
  }
  const activationRunner = createCfActivationRunner({
    cfOutput,
    accountId,
    apiBaseUrl,
    workerName,
    configPath: generatedConfigPath,
    runWrangler,
    cfUploaderIsPinned,
    verifyCompatibilityRunner: assertUploaderStillPinned,
  });
  const pinActiveSecrets = createActiveSecretPinner({
    output: cfOutput,
    handoffPending: pinnedHandoffLink !== null,
    requiredNames: schemaFacts.requiredKeys,
    ...(initialAuthSecret ? { explicitNames: [BETTER_AUTH_SECRET_NAME] } : {}),
  });
  const hasVersionMetadata =
    readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) !== undefined;
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      ...cloudflareCandidateActivationOptions({
        root,
        rootConfigPath: configPath,
        uploadConfigPath: generatedConfigPath,
        accountId,
        apiBaseUrl,
        complianceRegion,
        workerName,
        workersDevSubdomain,
        readinessAccessOrigin,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        existingWorker,
        pinnedHandoffLink,
        initialCloudflareCandidate,
        assertUploaderStillPinned,
        approvedKv: approvedHandoffKv,
        queueConsumerCleanup,
      }),
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      requireVersionMetadata: existingWorker === null || hasVersionMetadata,
      requirePreviewForReadiness: existingWorker !== null && !hasVersionMetadata,
      message: encodeCloudflareVersionMessage(
        migrations.map((migration) => migration.name),
        {
          ...readCloudflareTriggerConfig(generatedConfigPath, configPath),
          ...(existingWorker ? { preserve: true } : {}),
        },
      ),
      allowFirstDeploymentBootstrap: workerWasMissingBeforeSecretProvisioning,
      ...(pinActiveSecrets ? { pinActiveSecrets } : {}),
      atomic,
      ...(initialAuthSecret
        ? { candidateSecrets: { [BETTER_AUTH_SECRET_NAME]: initialAuthSecret } }
        : {}),
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    if (
      execution.reason === 'atomic-readiness-failed' ||
      execution.reason === 'atomic-readiness-access-denied'
    ) {
      // The atomic publish went live, so the saved candidate chain is stale.
      clearCloudflareCandidate(root);
    }
    await reportCloudflareActivationFailure(
      cliLog,
      needsSandbox && execution.containersUnavailable
        ? formatCloudflareSandboxUnavailable()
        : formatCloudflareActivationError(execution),
    );
    return exit(1);
  }
  recordCloudflareActivation({
    root,
    configPath,
    accountId,
    workerName,
    existingWorker,
    queueConsumerCleanup,
    execution,
    cliLog,
  });
  note(
    formatDeploySummary({
      workerName,
      migrations: appliedMigrations,
      d1MigrationsCurrent: d1MigrateToken !== undefined,
      // Existing Worker handoffs preserve remote triggers rather than publishing source jobs.
      cronJobs: existingWorker ? undefined : analysis.jobs.length,
      queues: existingWorker ? undefined : desired.queues.length,
      framework: detectedFramework?.name,
    }),
    execution.previewUrl,
  );
}
