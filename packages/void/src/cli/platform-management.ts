import { setTimeout as delay } from 'node:timers/promises';
import {
  parsePlatformInstallationManifest,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
  type InstallationResource,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
} from '@void/platform';
import { confirm, isCancel, log, outro, select } from '@voidzero-dev/vite-plus-prompts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { printSuccess, createSpinner, formatUrl, note, pc } from './output.ts';
import { activatePlatformAccessCredentials } from './platform-access-setup.ts';
import { turnOffInstalledProjectZeroTrust } from './platform-app-access.ts';
import type { PlatformArgs } from './platform-args.ts';
import { platformDatabaseNameFromOwnerUrl } from './platform-auth-database.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  resolvePlatformCloudflareCredential,
  verifyPlatformCloudflareCredential,
} from './platform-auth.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  hyperdriveOriginMatches,
  PlatformCloudflareClient,
  PlatformRuntimeTokenEmailPermissionError,
  verifyPlatformRuntimeTokenEmailPermissions,
  verifyPlatformRuntimeTokenPermissions,
} from './platform-cloudflare.ts';
import {
  authenticationSetupRequestHash,
  readLoginReplacementFile,
  replacePendingInstallationAuthentication,
} from './platform-install-auth.ts';
import {
  findPlatformWorkerOutsideChanges,
  formatPlatformWorkerOutsideChanges,
  reviewPlatformWorkerOutsideChanges,
  uploadPlatformWorkerOutsideChanges,
} from './platform-installer-outside-changes.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformHealthProbeToken,
  createPlatformInstallationSecrets,
  installPlatform,
  loadPlatformRuntime,
  readPlatformProjectSlugs,
  readPlatformProjectZeroTrustState,
  REMOTE_INSTALLATION_MANIFEST_KEY,
  resolveBootstrapGitHubId,
  type PlatformDatabaseLifecycleLock,
} from './platform-installer.ts';
import {
  assertNoninteractivePlatformMutationAcknowledged,
  resolvePlatformInstallDatabaseUrl,
} from './platform-lifecycle.ts';
import {
  createPlatformInstallPlan,
  dnsRecordConfigHash,
  formatPlatformInstallPlan,
  hasProvisionIntentStep,
  legacyResourceConfigHash,
  matchesRecordedR2Fingerprint,
  platformAdoptionIntentHash,
  r2BucketConfigHash,
  resourceMarkerProblem,
  revalidatePlatformInstallAction,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  listInstallationManifests,
  readInstallationRecoverySecrets,
  readPendingInstallationSecrets,
  removeInstallationRecoverySecrets,
  removePlatformConnectionForInstallation,
  resolveInstallationManifest,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import {
  assertNoPlatformProjects,
  checkPurgeResourcesCredentials,
  describePurgeResourcesPlan,
  isPlatformTailWorker,
  isPurgeResourcesCandidate,
  isPurgedAccessResource,
  PlatformResourceChangedError,
  purgeResourcesAlwaysKept,
  purgeResourcesHandlesEmailRouting,
  purgeResourcesKeptReason,
  purgeResourcesKeptResources,
  purgeResourcesPermissions,
  PURGE_RESOURCES_STEP_PREFIX,
  runPurgeResourcesTeardown,
  type PurgeResourcesClient,
  type PurgeResourcesCredential,
} from './platform-teardown.ts';
import {
  assertProjectZeroTrustAllowsUninstall,
  formatZeroTrustApplications,
  type PlatformProjectZeroTrustState,
} from './platform-zero-trust-uninstall.ts';

type PlatformManagementClient = Pick<
  PlatformCloudflareClient,
  | 'deleteKvValue'
  | 'deleteResource'
  | 'findZone'
  | 'getHyperdriveConfig'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'putKvValue'
>;

type PlatformUninstallClient = PlatformManagementClient &
  Pick<PlatformCloudflareClient, 'listWorkerDomains' | 'listWorkerServiceRoutes'> &
  PurgeResourcesClient;

type PlatformOwnershipClient = Pick<
  PlatformManagementClient,
  | 'findZone'
  | 'getHyperdriveConfig'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
>;

export async function verifyPlatformInstallationOwnership(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  options: {
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
    databaseUrl?: string;
    retainedReplacementKeys?: ReadonlySet<string>;
  } = {},
): Promise<void> {
  const ready = manifest.resources.filter(
    (resource) =>
      resource.state === 'ready' &&
      isOwnershipVerifiableKind(resource.kind) &&
      !options.retainedReplacementKeys?.has(resource.key),
  );
  const routing = ready.find((resource) => resource.key === 'routing-kv');
  if (!routing) {
    const unsafe = ready.filter((resource) => resource.kind !== 'zone');
    if (unsafe.length > 0) {
      throw ownershipError(
        `the remote installation checkpoint is missing for ${unsafe[0]!.kind} ${unsafe[0]!.name}`,
      );
    }
    const zone = ready.find((resource) => resource.kind === 'zone');
    if (zone) {
      const current = await client.findZone(manifest.account.id, zone.name);
      if (current?.id !== zone.id) {
        throw ownershipError(`zone ${zone.name} was replaced`);
      }
    }
    return;
  }
  await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set(ready.map((resource) => resource.key)),
    options,
  );
}

type PlatformManagementDependencies = Readonly<{
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  confirm?: (message: string, initialValue: boolean) => Promise<boolean>;
  databaseUrl?: string;
  interactive?: boolean;
  /** Uninstall refuses to start when this is missing or cannot read the state. */
  readProjectZeroTrust?: () => Promise<PlatformProjectZeroTrustState>;
  /** Holds off Zero Trust writers from the final check until traffic is disabled. */
  lockProjectZeroTrust?: () => Promise<() => Promise<void>>;
  /** Makes Zero Trust writers that later get the lock refuse; called while it is held. */
  fenceProjectZeroTrust?: () => Promise<void>;
  /** Removes that fence when uninstall stops before it disables traffic. */
  liftProjectZeroTrustFence?: () => Promise<void>;
  /**
   * Turns off project Zero Trust through the platform API while no platform
   * user exists. Present only with the installer's saved app access authority.
   */
  turnOffProjectZeroTrust?: () => Promise<void>;
  /** Project slugs; --purge-resources refuses to start while any remain or when this cannot read them. */
  readProjects?: () => Promise<ReadonlyArray<string>>;
  /** Where the operator credential came from; --purge-resources checks it before any change. */
  credential?: PurgeResourcesCredential;
}>;

export function selectAuthoritativePlatformManifest(
  local: PlatformInstallationManifest,
  authoritative: PlatformInstallationManifest | null | undefined,
): PlatformInstallationManifest {
  if (!authoritative) {
    return local;
  }
  if (
    authoritative.id !== local.id ||
    authoritative.ownershipNonce !== local.ownershipNonce ||
    authoritative.account.id !== local.account.id
  ) {
    throw new Error('platform: The authoritative lifecycle state belongs to another installation.');
  }
  return authoritative;
}

function commandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function platformLifecycleResumeCommand(
  args: Extract<
    PlatformArgs,
    { subcommand: 'upgrade' | 'rollback' | 'repair' | 'disable' | 'enable' }
  >,
  installationId: string,
): string {
  const command = ['void', 'platform', args.subcommand, commandArgument(installationId)];
  if (args.runtime) {
    command.push('--runtime', commandArgument(args.runtime));
  }
  if (args.subcommand === 'rollback' && args.fromRuntime) {
    command.push('--from-runtime', commandArgument(args.fromRuntime));
  }
  if ('dashboardUrl' in args && args.dashboardUrl) {
    command.push('--dashboard-url', commandArgument(args.dashboardUrl));
  }
  if (args.yes) {
    command.push('--yes');
  }
  return command.join(' ');
}

export async function runInstalledPlatformCommand(args: PlatformArgs): Promise<void> {
  if (
    args.subcommand !== 'upgrade' &&
    args.subcommand !== 'rollback' &&
    args.subcommand !== 'repair' &&
    args.subcommand !== 'disable' &&
    args.subcommand !== 'enable' &&
    args.subcommand !== 'uninstall'
  ) {
    throw new Error(`platform: Unsupported lifecycle command ${args.subcommand}.`);
  }
  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);
  const timingStart = performance.now();
  let timingPrevious = timingStart;
  const markPhase = (phase: string) => {
    if (process.env.VOID_PLATFORM_TIMINGS !== '1') {
      return;
    }
    const current = performance.now();
    process.stderr.write(
      `[platform timing] phase ${phase} ${(current - timingPrevious).toFixed(0)} ms, total ${(current - timingStart).toFixed(0)} ms\n`,
    );
    timingPrevious = current;
  };
  const manifest = await resolveInstalledPlatformManifest(args.selector);
  const operatorCredential = await resolvePlatformCloudflareCredential({
    savedManagementToken: readInstallationRecoverySecrets(manifest)?.managementApiToken,
  });
  const operatorClient = new PlatformCloudflareClient(operatorCredential.token);
  await verifyPlatformCloudflareCredential(operatorClient, {
    account: manifest.account,
    source: operatorCredential.source,
    r2Buckets:
      args.subcommand === 'disable' || args.subcommand === 'uninstall'
        ? []
        : manifest.resources
            .filter((resource) => resource.kind === 'r2-bucket')
            .map((resource) => resource.name),
    allowMissingR2Buckets: args.subcommand === 'repair',
  });
  markPhase('operator credential');
  const runtime =
    args.subcommand === 'uninstall' || args.subcommand === 'disable'
      ? null
      : loadPlatformRuntime(args.runtime);
  const rollbackSourceRuntime =
    args.subcommand === 'rollback' ? loadPlatformRuntime(args.fromRuntime) : null;
  let progress: ReturnType<typeof createSpinner> | undefined;
  let reportResult: (() => void) | undefined;

  const execute = async (
    manifest: PlatformInstallationManifest,
    databaseLock?: PlatformDatabaseLifecycleLock,
    databaseCheckpointExists = false,
  ): Promise<void> => {
    if (args.subcommand === 'rollback') {
      assertPlatformRollbackCompatibility(manifest, runtime!, rollbackSourceRuntime!);
    }
    const recovery = readInstallationRecoverySecrets(manifest);
    const gatewayToken =
      process.env.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN || recovery?.cloudflareApiToken;
    const client =
      operatorCredential.source === 'oauth' && gatewayToken
        ? operatorClient.withAiGatewayToken(gatewayToken)
        : operatorClient;
    const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, manifest);

    if (args.subcommand === 'disable') {
      await disablePlatform(client, manifest, args.plan, {
        checkpoint: databaseLock?.checkpoint,
        databaseUrl,
      });
      return;
    }
    if (args.subcommand === 'uninstall') {
      const apiUrl = manifest.endpoints.apiUrl;
      const appAccessSetupToken = recovery?.appAccessSetupToken;
      await uninstallPlatform(client, manifest, args, {
        checkpoint: databaseLock?.checkpoint,
        databaseUrl,
        // A plan holds no lifecycle lock, so it opens its own read-only connection.
        readProjectZeroTrust: databaseLock
          ? databaseLock.readProjectZeroTrust
          : () =>
              readPlatformProjectZeroTrustState(databaseUrl, manifest.id, manifest.ownershipNonce),
        lockProjectZeroTrust: databaseLock?.lockProjectZeroTrust,
        fenceProjectZeroTrust: databaseLock?.fenceProjectZeroTrust,
        liftProjectZeroTrustFence: databaseLock?.liftProjectZeroTrustFence,
        readProjects: databaseLock
          ? databaseLock.readProjects
          : () => readPlatformProjectSlugs(databaseUrl, manifest.id, manifest.ownershipNonce),
        credential: { source: operatorCredential.source, aiGatewayToken: !!gatewayToken },
        ...(apiUrl && appAccessSetupToken
          ? {
              turnOffProjectZeroTrust: async () => {
                const saved: unknown = recovery?.accessCredentialsJson
                  ? JSON.parse(recovery.accessCredentialsJson)
                  : {};
                if (saved && typeof saved === 'object' && apiUrl in saved) {
                  activatePlatformAccessCredentials(
                    JSON.stringify({ [apiUrl]: (saved as Record<string, unknown>)[apiUrl] }),
                    [apiUrl],
                  );
                }
                if (manifest.deployment.authentication.accessProtection) {
                  ensurePlatformAccessToken(apiUrl, false, true);
                }
                await turnOffInstalledProjectZeroTrust({
                  apiUrl,
                  installationId: manifest.id,
                  probeToken: createPlatformHealthProbeToken(manifest.ownershipNonce),
                  setupToken: appAccessSetupToken,
                  updateCommand: readPendingInstallationSecrets(manifest)
                    ? `void platform install --resume --name ${commandArgument(manifest.id)}`
                    : `void platform upgrade ${commandArgument(manifest.id)}`,
                });
              },
            }
          : {}),
      });
      return;
    }
    if (
      args.subcommand === 'enable' &&
      manifest.desiredState === 'enabled' &&
      manifest.status === 'installed'
    ) {
      log.info(`${manifest.deployment.displayName} is already enabled.`);
      return;
    }

    // repair --auth-config replaces the login settings of a first administrator
    // setup that is still pending. Refuse what no database read can change first.
    const loginFile = args.subcommand === 'repair' ? args.authConfig : undefined;
    if (loginFile !== undefined) {
      if (manifest.desiredState === 'disabled') {
        throw new Error(
          `platform: This platform is disabled. Run \`void platform enable ${commandArgument(manifest.id)}\` first, then repair to change the login settings.`,
        );
      }
      if (!manifest.deployment.authentication.configurable) {
        throw new Error(
          'platform: This installation signs in with the GitHub OAuth App from its installation settings. Set VOID_PLATFORM_GITHUB_CLIENT_ID and VOID_PLATFORM_GITHUB_CLIENT_SECRET when running repair to replace it.',
        );
      }
      if (!recovery?.authenticationSetupJson || !recovery.authSetupToken) {
        throw new Error(
          'platform: Changing the login settings needs the setup authority saved on the computer that installed the platform. Run this repair there.',
        );
      }
      await readLoginReplacementFile(
        loginFile,
        manifest.deployment.authentication,
        recovery.authenticationSetupJson,
      );
    }
    const deployment = manifest.deployment;
    const planInput = {
      accountId: manifest.account.id,
      ...(args.subcommand === 'upgrade' && process.env.VOID_EMAIL_SHARED_ZONE_ID
        ? { emailSharedZoneId: process.env.VOID_EMAIL_SHARED_ZONE_ID }
        : {}),
      ...(args.subcommand === 'upgrade' && process.env.VOID_EMAIL_SENDER_DOMAIN
        ? { emailSenderDomain: process.env.VOID_EMAIL_SENDER_DOMAIN }
        : {}),
      applicationDomain: deployment.application.baseDomain,
      controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
      ...(args.subcommand !== 'rollback' && args.dashboardUrl !== undefined
        ? { dashboardUrl: args.dashboardUrl }
        : {}),
      dedicatedZone: deployment.application.dedicatedZone,
      displayName: deployment.displayName,
      installationSlug: deployment.installationSlug,
      zoneName: deployment.application.zoneName,
    };
    const plan = await createPlatformInstallPlan(client, planInput, manifest, {
      authoritativeProvisionIntents: databaseCheckpointExists,
      repairMissing: args.subcommand === 'repair',
      allowUnverifiedAiGateway: args.plan,
      includeEmailGateway: runtime!.manifest.artifacts.emailGateway !== undefined,
      enableSandbox: runtime!.manifest.safetyProtocols.sandboxDrain >= 3,
      deploymentExecution: runtime!.manifest.deploymentExecution === 1,
    });
    markPhase('plan');
    note(
      formatPlatformInstallPlan(plan),
      args.subcommand === 'upgrade'
        ? 'Upgrade plan'
        : args.subcommand === 'rollback'
          ? 'Rollback plan'
          : args.subcommand === 'enable'
            ? 'Enable plan'
            : 'Repair plan',
    );
    note(
      [
        `Version: ${manifest.platformVersion} → ${runtime!.manifest.platformVersion}`,
        `Source: ${runtime!.source}`,
        `Revision: ${runtime!.manifest.sourceRevision ?? 'not recorded'}`,
        `Manifest SHA-256: ${runtime!.manifestSha256}`,
      ].join('\n'),
      'Platform runtime',
    );
    log.info(
      manifest.desiredState === 'disabled' && args.subcommand !== 'enable'
        ? 'Application traffic will stay paused because this installation is disabled.'
        : 'Application traffic may pause briefly during a safe cutover.',
    );
    if (args.plan) {
      if (loginFile !== undefined) {
        log.info(
          `Login settings will be replaced from ${loginFile}; a new setup code is printed at the end.`,
        );
      }
      // A plan holds no lifecycle lock, so it cannot read the database.
      const outsideChanges = await findPlatformWorkerOutsideChanges(client, plan, runtime!, {
        manifest,
      });
      if (outsideChanges.length > 0) {
        log.warn(
          `${formatPlatformWorkerOutsideChanges(outsideChanges)}\nThis command replaces their configuration with the Void configuration. Run it in a terminal to review them first.`,
        );
      }
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    assertPlatformOperatorCredentialCanApplyPlan(operatorCredential, plan);
    const repairingMissingRoutingCheckpoint =
      args.subcommand === 'repair' &&
      plan.actions.some(
        (action) => action.key === 'routing-kv' && action.action === 'create' && action.id === null,
      );
    await verifyPlatformMutationOwnership(
      client,
      manifest,
      new Set(
        manifest.resources
          .filter(
            (resource) =>
              isOwnershipVerifiableKind(resource.kind) &&
              !plan.actions.some(
                (action) =>
                  action.key === resource.key &&
                  action.action === 'create' &&
                  action.name !== resource.name,
              ),
          )
          .map((resource) => resource.key),
      ),
      {
        allowMissingRoutingCheckpoint: repairingMissingRoutingCheckpoint,
        allowUninitializedRoutingCheckpoint:
          args.subcommand === 'repair' && databaseCheckpointExists,
        databaseUrl,
      },
    );
    markPhase('ownership');
    let replacedLogin: { authenticationSetupJson: string; authBootstrapCode: string } | undefined;
    if (
      args.subcommand === 'repair' &&
      (loginFile !== undefined || (process.stdin.isTTY && !args.yes)) &&
      manifest.desiredState !== 'disabled' &&
      manifest.deployment.authentication.configurable &&
      recovery?.authenticationSetupJson &&
      recovery.authSetupToken
    ) {
      const setup = await databaseLock?.readAdministratorSetup?.();
      if (loginFile !== undefined) {
        if (!setup) {
          throw new Error(
            'platform: The database lifecycle lock cannot read the administrator setup.',
          );
        }
        if (setup.usersExist || (setup.requestHash !== null && !setup.pending)) {
          throw new Error(
            'platform: The first administrator has already signed in. Change login methods with `void platform config auth`.',
          );
        }
        if (setup.requestHash === null) {
          throw new Error(
            `platform: Administrator setup was never started. Resume the install with \`void platform install --resume --name ${commandArgument(manifest.id)}\`.`,
          );
        }
      }
      if (
        setup?.pending &&
        !setup.usersExist &&
        (loginFile !== undefined ||
          (await promptForConfirmation(
            'First administrator setup is not finished. Change the login settings before continuing?',
            false,
          )))
      ) {
        replacedLogin = await replacePendingInstallationAuthentication({
          ...(loginFile !== undefined ? { file: loginFile } : {}),
          authentication: manifest.deployment.authentication,
          setupJson: recovery.authenticationSetupJson,
          apiUrl: plan.apiUrl,
        });
      }
    }
    const installation =
      args.subcommand === 'enable'
        ? setInstallationDesiredState(manifest, 'enabled', new Date().toISOString())
        : manifest;
    const bootstrapGitHubLogin =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_LOGIN || recovery?.bootstrapGitHubLogin || '';
    const bootstrapGitHubId =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
      recovery?.bootstrapGitHubId ||
      (bootstrapGitHubLogin ? await resolveBootstrapGitHubId(bootstrapGitHubLogin) : '');
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId,
      bootstrapGitHubLogin,
      cloudflareApiToken: process.env.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN || '',
      checkpoint: recovery,
      databaseUrl,
      emailEnabled: plan.deployment.capabilities.email,
      emailSigningSecret: process.env.VOID_PLATFORM_EMAIL_SIGNING_SECRET || '',
      existingEmailEnabled: manifest.deployment.capabilities.email,
      existingInstallation: true,
      updateExistingWorkers: true,
      githubClientId: process.env.VOID_PLATFORM_GITHUB_CLIENT_ID || '',
      githubClientSecret: process.env.VOID_PLATFORM_GITHUB_CLIENT_SECRET || '',
      jwtSecret: process.env.VOID_PLATFORM_JWT_SECRET || '',
      projectSecretKey: process.env.VOID_PLATFORM_PROJECT_SECRET_KEY || '',
      projectSecretKeysJson: process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON || '',
      projectSecretActiveKeyVersion:
        process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION || '',
      r2AccessKeyId: process.env.VOID_PLATFORM_R2_ACCESS_KEY_ID || '',
      r2SecretAccessKey: process.env.VOID_PLATFORM_R2_SECRET_ACCESS_KEY || '',
      ...replacedLogin,
    });
    const runtimeTokenToPreflight = resolvePlatformRuntimeTokenToPreflight(plan, secrets);
    // Shared email setup runs after traffic pauses and uses the runtime token,
    // also when this run keeps the saved token. Check its email access first.
    const emailZoneId =
      installation.desiredState !== 'disabled' && plan.deployment.capabilities.email
        ? plan.deployment.emailSharedZoneId
        : undefined;
    if (runtimeTokenToPreflight) {
      await verifyPlatformRuntimeTokenPermissions(
        new PlatformCloudflareClient(runtimeTokenToPreflight),
        {
          accountId: manifest.account.id,
          applicationDomain: deployment.application.baseDomain,
          customDomains: plan.deployment.capabilities.customDomains,
          ...(emailZoneId ? { emailZoneId } : {}),
          zoneId: plan.zone?.id ?? null,
        },
      );
    } else if (emailZoneId && secrets.cloudflareApiToken) {
      try {
        await verifyPlatformRuntimeTokenEmailPermissions(
          new PlatformCloudflareClient(secrets.cloudflareApiToken),
          { accountId: manifest.account.id, savedToken: true, zoneId: emailZoneId },
        );
      } catch (error) {
        // This run does not send the saved token to the Workers. A run from
        // another machine can have replaced their token, and the old one was
        // then revoked. Only a valid token that lacks a permission stops here.
        if (!(error instanceof PlatformRuntimeTokenEmailPermissionError) || !error.tokenNotValid) {
          throw error;
        }
        log.warn(
          'The runtime API token saved on this machine is not valid (HTTP 401). Void cannot check the platform email permissions before it changes the platform, and it continues without this check. To do the check, set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to the runtime token of the platform.',
        );
      }
    }
    markPhase('runtime token');
    if (!databaseLock?.readAuthenticationState) {
      throw new Error(
        'platform: The database lifecycle lock cannot read authoritative authentication settings.',
      );
    }
    // Without a terminal, the Cloudflare CLI stops the upload of a Worker
    // changed outside Void, and the upgrade refuses an active version without
    // Void's record of its triggers. Both happen after traffic pauses. Find
    // them first.
    const outsideChanges = await reviewPlatformWorkerOutsideChanges({
      client,
      plan,
      runtime: runtime!,
      installation: {
        manifest: installation,
        readAuthenticationState: databaseLock.readAuthenticationState,
      },
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true && !args.yes,
      command: platformLifecycleResumeCommand({ ...args, yes: false }, manifest.id),
    });
    markPhase('outside changes');
    progress = createSpinner({
      // Preserve the subprocess signal coordinator used by platform installs.
      onCancel: () => {
        if (!process.emit('SIGINT')) {
          process.exit(130);
        }
      },
    });
    progress.start(
      args.subcommand === 'upgrade'
        ? 'Upgrading the platform'
        : args.subcommand === 'rollback'
          ? 'Rolling back the platform'
          : args.subcommand === 'enable'
            ? 'Enabling the platform'
            : 'Repairing the platform',
    );
    if (installation !== manifest) {
      writeInstallationManifest(installation);
    }
    // The platform refuses new login settings once an administrator signed in.
    // Keep the saved settings the platform still has, so later lifecycle
    // commands do not resend the refused ones.
    const keepAcceptedLogin = async (error: unknown): Promise<unknown> => {
      const after = replacedLogin
        ? await databaseLock?.readAdministratorSetup?.().catch(() => undefined)
        : undefined;
      if (
        !after ||
        !recovery?.authenticationSetupJson ||
        after.requestHash !== authenticationSetupRequestHash(recovery.authenticationSetupJson) ||
        (!after.usersExist && after.pending)
      ) {
        return error;
      }
      const pending = readPendingInstallationSecrets(installation);
      if (pending) {
        writePendingInstallationSecrets(installation, {
          ...pending,
          authenticationSetupJson: recovery.authenticationSetupJson,
          ...(recovery.authBootstrapCode ? { authBootstrapCode: recovery.authBootstrapCode } : {}),
        });
      }
      return new Error(
        'platform: The first administrator signed in before the new login settings were applied. Nothing changed. Change login methods with `void platform config auth`.',
        { cause: error },
      );
    };
    const result = await installPlatform(plan, secrets, installation, {
      // runInstalledPlatformCommand holds the database session lock across the
      // entire replan and mutation sequence.
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          checkpoint: databaseLock?.checkpoint,
          liftProjectZeroTrustFence: databaseLock?.liftProjectZeroTrustFence,
          prepareDatabase: databaseLock?.prepareDatabase,
          prepareSandboxDrain: databaseLock?.prepareSandboxDrain,
          readAuthenticationState: databaseLock?.readAuthenticationState,
          requiredSafetyProtocols: databaseLock?.requiredSafetyProtocols,
          verifyDatabase: databaseLock?.verifyDatabase,
        }),
      client,
      operatorApiToken: operatorCredential.token,
      ...(outsideChanges.length > 0
        ? {
            replaceOutsideChanges: outsideChanges.map((change) => change.name),
            uploadOutsideChanges: (configs: ReadonlyArray<Record<string, unknown>>) =>
              uploadPlatformWorkerOutsideChanges(configs, {
                changes: outsideChanges,
                client,
                operatorApiToken: operatorCredential.token,
                progress,
              }),
          }
        : {}),
      databaseRollbackSource: rollbackSourceRuntime ?? undefined,
      onProgress: (message) => {
        markPhase(message);
        progress?.message(message);
      },
      runtime: runtime!,
      operation: args.subcommand,
      replanWorkers: async (recoveryManifest) =>
        (
          await createPlatformInstallPlan(client, planInput, recoveryManifest, {
            authoritativeProvisionIntents: true,
            repairMissing: true,
            includeEmailGateway: runtime!.manifest.artifacts.emailGateway !== undefined,
            enableSandbox: runtime!.manifest.safetyProtocols.sandboxDrain >= 3,
            deploymentExecution: runtime!.manifest.deploymentExecution === 1,
          })
        ).actions.filter((action) => action.kind === 'worker'),
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action, {
          repairMissing: args.subcommand === 'repair',
          stableWorkerUpdate: args.subcommand === 'upgrade',
        }),
    }).catch(async (error: unknown) => {
      throw await keepAcceptedLogin(error);
    });
    // Keep progress visible while the outer database session releases its lock.
    progress.message('Finalizing platform changes');
    markPhase('installer complete');
    reportResult = () => {
      progress?.stop(
        result.waitingForDns || result.waitingForSandboxDrain
          ? 'Platform operation paused; progress is saved.'
          : `Platform ${args.subcommand} complete.`,
      );
      progress = undefined;
      if (result.waitingForDns) {
        note(
          `Wait for ${deployment.application.zoneName} to become active, then resume:\n${platformLifecycleResumeCommand(args, manifest.id)}`,
          'Waiting for nameservers',
        );
        return;
      }
      if (result.waitingForSandboxDrain) {
        note(
          [
            'Application traffic is paused. Saved progress is ready to resume.',
            '1. Review remaining Sandbox work: void platform system sandbox-drain --plan',
            "2. Apply: void platform system sandbox-drain --yes (follow nextCursor with --cursor '<value>' until complete: true).",
            `3. Resume: ${platformLifecycleResumeCommand(args, manifest.id)}`,
            `Administrator status: ${plan.apiUrl}/admin/status`,
          ].join('\n'),
          'Waiting for managed Sandbox drain',
        );
        return;
      }
      log.info(
        result.manifest.desiredState === 'disabled'
          ? 'Application traffic remains paused. Enable the installation when you are ready.'
          : `Platform verification passed. Traffic is enabled at ${plan.apiUrl}.`,
      );
      if (args.subcommand === 'rollback') {
        log.info('PostgreSQL migrations were retained; rollback changes the runtime only.');
      }
      if (result.emailOperationId) {
        log.info(`Shared email routing ready (operation ${result.emailOperationId}).`);
      }
      if (result.setupPending) {
        const code = readInstallationRecoverySecrets(result.manifest)?.authBootstrapCode;
        if (code) {
          log.info(`First administrator setup: ${formatUrl(`${plan.apiUrl}/setup`)}`);
          console.log(`One-time administrator setup code: ${code}`);
          log.info(`Login callback URL: ${formatUrl(`${plan.apiUrl}/auth/callback`)}`);
          log.info(
            `If sign-in fails, run \`void platform repair ${commandArgument(manifest.id)}\` to change the login settings.`,
          );
        }
      }
      printSuccess(
        `${deployment.displayName}: runtime ${runtime!.manifest.platformVersion} ${args.subcommand === 'rollback' ? 'restored' : 'ready'}.`,
      );
    };
  };

  if (args.plan) {
    await execute(manifest);
    return;
  }
  const release = acquirePlatformLifecycleLock(
    manifest.account.id,
    manifest.deployment.installationSlug,
  );
  try {
    const current = resolveInstallationManifest(manifest.id);
    const recovery = readInstallationRecoverySecrets(current);
    const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, current);
    if (!databaseUrl) {
      throw new Error(
        'platform: DATABASE_URL is required to safely serialize lifecycle changes across hosts.',
      );
    }
    const releaseDatabase = await acquirePlatformDatabaseLifecycleLock(
      databaseUrl,
      current.id,
      current.ownershipNonce,
    );
    markPhase('database lock');
    try {
      const authoritative = releaseDatabase.authoritativeManifest;
      const databaseCheckpointExists = authoritative !== null && authoritative !== undefined;
      const currentManifest = selectAuthoritativePlatformManifest(current, authoritative);
      if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(current)) {
        writeInstallationManifest(authoritative);
      }
      if (!authoritative) {
        await releaseDatabase.checkpoint?.(currentManifest);
      }
      await execute(currentManifest, releaseDatabase, databaseCheckpointExists);
    } finally {
      await releaseDatabase();
    }
    reportResult?.();
    markPhase('complete');
  } catch (error) {
    const operationStarted = progress !== undefined;
    progress?.error(`Platform ${args.subcommand} failed.`);
    progress = undefined;
    if (operationStarted && args.subcommand !== 'uninstall' && args.subcommand !== 'disable') {
      note(
        [
          'Traffic may remain paused. Inspect the saved state before continuing:',
          `void platform status ${commandArgument(manifest.id)}`,
          'After resolving the error, resume with the same runtime:',
          platformLifecycleResumeCommand(args, manifest.id),
        ].join('\n'),
        'Recovery',
      );
    }
    throw error;
  } finally {
    try {
      progress?.clear();
    } finally {
      release();
    }
  }
}

export function assertPlatformRollbackCompatibility(
  installation: PlatformInstallationManifest,
  target: ReturnType<typeof loadPlatformRuntime>,
  source: ReturnType<typeof loadPlatformRuntime>,
): void {
  if (
    target.manifest.emailProtocolVersion !== 1 &&
    (installation.deployment.capabilities.email ||
      installation.resources.some(
        (resource) => resource.key === 'email-gateway-worker' && resource.state === 'ready',
      ))
  ) {
    throw new Error(
      'platform: The rollback target predates the email gateway and cannot safely replace this installation. Use a runtime with email protocol version 1.',
    );
  }
  if (!installation.runtime) {
    throw new Error(
      'platform: The installed runtime has no artifact provenance, so post-success rollback cannot identify its compatibility manifest.',
    );
  }
  if (
    source.manifest.platformVersion !== installation.platformVersion ||
    source.manifestSha256 !== installation.runtime.manifestSha256
  ) {
    throw new Error(
      'platform: --from-runtime does not exactly match the installed runtime artifact digest. Supply the runtime used by the current successful deployment.',
    );
  }
  if (target.manifestSha256 === source.manifestSha256) {
    throw new Error('platform: The rollback target is already the installed runtime artifact.');
  }
  if (
    (target.manifest.authenticationProtocolVersion ?? 0) <
    Math.max(
      source.manifest.authenticationProtocolVersion ?? 0,
      installation.deployment.authentication.configurable ? 1 : 0,
    )
  ) {
    throw new Error(
      'platform: The rollback target cannot enforce the installed authentication configuration and session revocation protocol. Use a compatible runtime.',
    );
  }
  if (
    Math.max(installation.usageProtocolVersion, source.manifest.usageProtocolVersion) >= 2 &&
    target.manifest.usageProtocolVersion < 2
  ) {
    throw new Error(
      'platform: The rollback target predates ownership-aware usage attribution and cannot safely account for transferred projects. Use a runtime with usage protocol version 2 or newer.',
    );
  }
  if (target.manifest.database.lineage !== source.manifest.database.lineage) {
    throw new Error('platform: The rollback target belongs to a different database lineage.');
  }
  const prefix = source.manifest.database.migrations.slice(
    0,
    target.manifest.database.migrations.length,
  );
  if (JSON.stringify(prefix) !== JSON.stringify(target.manifest.database.migrations)) {
    throw new Error(
      'platform: The rollback target database migrations are not an exact prefix of the installed runtime.',
    );
  }
  const compatible = source.manifest.database.rollbackSafeFrom.some(
    (entry) =>
      entry.platformVersion === target.manifest.platformVersion &&
      entry.schemaDigest === target.manifest.database.schemaDigest,
  );
  if (!compatible) {
    throw new Error(
      `platform: Installed runtime ${source.manifest.platformVersion} does not declare post-success rollback compatibility with ${target.manifest.platformVersion} at schema ${target.manifest.database.schemaDigest}.`,
    );
  }
  if (installation.databaseSchemaDigest !== source.manifest.database.schemaDigest) {
    throw new Error(
      'platform: The authoritative installation checkpoint does not record the installed runtime database schema. Repair or roll forward before rollback.',
    );
  }
  if (target.manifest.safetyProtocols.sandboxDrain < installation.safetyProtocols.sandboxDrain) {
    throw new Error(
      'platform: The rollback target predates the installed sandbox-drain safety protocol.',
    );
  }
}

export function resolvePlatformRuntimeTokenToPreflight(
  plan: {
    actions: ReadonlyArray<{ action: string; key: string; kind: string }>;
  },
  secrets: Pick<
    ReturnType<typeof createPlatformInstallationSecrets>,
    'cloudflareApiToken' | 'workerSecretUpdates'
  >,
): string {
  const explicitUpdate = secrets.workerSecretUpdates?.CF_API_TOKEN;
  if (explicitUpdate) {
    return explicitUpdate;
  }
  return plan.actions.some(
    (action) =>
      action.kind === 'worker' &&
      action.action === 'create' &&
      (action.key === 'api-worker' || action.key === 'proxy-worker'),
  )
    ? secrets.cloudflareApiToken
    : '';
}

export async function resolveInstalledPlatformManifest(
  selector: string,
  dependencies: {
    interactive?: boolean;
    selectInstallation?: (
      manifests: ReadonlyArray<PlatformInstallationManifest>,
    ) => Promise<string>;
  } = {},
): Promise<PlatformInstallationManifest> {
  if (selector) {
    return resolveInstallationManifest(selector);
  }
  const manifests = listInstallationManifests().filter(
    (manifest) => manifest.status !== 'uninstalled',
  );
  if (manifests.length <= 1) {
    return resolveInstallationManifest('');
  }
  if (!(dependencies.interactive ?? process.stdin.isTTY)) {
    throw new Error('platform: Multiple local installations exist; specify an installation id.');
  }
  const picked = dependencies.selectInstallation
    ? await dependencies.selectInstallation(manifests)
    : await select({
        message: 'Select an installed Void platform:',
        options: manifests.map((manifest) => ({
          hint: `${manifest.account.name} · ${manifest.id}`,
          label: manifest.deployment.displayName,
          value: manifest.id,
        })),
      });
  if (isCancel(picked)) {
    throw new Error('platform: Cancelled.');
  }
  return resolveInstallationManifest(String(picked));
}

export async function disablePlatform(
  client: PlatformManagementClient,
  initialManifest: PlatformInstallationManifest,
  planOnly: boolean,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const manifest = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const saveCheckpoint = (state: PlatformInstallationManifest) =>
    writeLifecycleCheckpoint(client, state, dependencies.checkpoint);
  const saveRemoteManifest = (state: PlatformInstallationManifest) =>
    writeRemoteManifest(client, state, dependencies.checkpoint);
  note(
    'Block all platform traffic and the platform API. Routes, custom domains, Workers, and data stay installed.',
    'Disable plan',
  );
  if (planOnly) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
  }
  const alreadyDisabled = manifest.status === 'disabled';
  await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set([
      'routing-kv',
      'zone',
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.key),
    ]),
    { databaseUrl: dependencies.databaseUrl },
  );
  let next = setInstallationDesiredState(manifest, 'disabled', new Date().toISOString());
  writeInstallationManifest(next);
  if (!alreadyDisabled) {
    next = transitionInstallation(next, 'disabling', new Date().toISOString());
    writeInstallationManifest(next);
  }
  try {
    await saveRemoteManifest(next);
    const routing = requireResource(next, 'routing-kv');
    const trafficGeneration = currentTrafficGeneration(next);
    await client.putKvValue(
      next.account.id,
      routing.id,
      PLATFORM_DISABLED_KEY,
      PLATFORM_DISABLED_VALUE,
    );
    next = markTrafficAttachmentsRetained(next);
    if (!hasLifecycleStep(next, `disable:${trafficGeneration}:routes`)) {
      next = recordLifecycleStep(next, `disable:${trafficGeneration}:routes`);
    }
    await saveCheckpoint(next);
    next = transitionInstallation(next, 'disabled', new Date().toISOString());
    await saveCheckpoint(next);
    printSuccess(`${next.deployment.displayName} is disabled. Its data was not changed.`);
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    await saveRemoteManifest(next).catch(() => {});
    throw error;
  }
}

export async function uninstallPlatform(
  client: PlatformUninstallClient,
  initialManifest: PlatformInstallationManifest,
  args: Extract<PlatformArgs, { subcommand: 'uninstall' }>,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const manifest = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const saveCheckpoint = (state: PlatformInstallationManifest) =>
    writeLifecycleCheckpoint(client, state, dependencies.checkpoint);
  const saveRemoteManifest = (state: PlatformInstallationManifest) =>
    writeRemoteManifest(client, state, dependencies.checkpoint);
  const retainData = !args.purgeData;
  const purgeResources = args.purgeResources;
  const routingKv = manifest.resources.find((resource) => resource.key === 'routing-kv');
  // --purge-resources also uses routing KV that an uninstall which stopped before it
  // finished recorded as retained.
  const reopenedRouting =
    purgeResources &&
    routingKv?.state === 'retained' &&
    isPurgeResourcesCandidate(manifest, routingKv);
  const hasRoutingCheckpoint = routingKv?.state === 'ready' || reopenedRouting;
  const interactive = dependencies.interactive ?? process.stdin.isTTY;
  const confirmAction = dependencies.confirm ?? promptForConfirmation;
  const zeroTrust = await assertProjectZeroTrustAllowsUninstall(dependencies.readProjectZeroTrust, {
    canTurnOff: !!dependencies.turnOffProjectZeroTrust,
  });
  if (purgeResources) {
    await assertNoPlatformProjects(dependencies.readProjects);
  }
  if (args.plan || (interactive && !args.yes)) {
    note(
      [
        ...(zeroTrust
          ? zeroTrust.turnOff.length
            ? [
                'Turn off project Zero Trust; no platform user exists yet. Delete its Access applications:',
                formatZeroTrustApplications(zeroTrust.turnOff),
              ]
            : ['Turn off project Zero Trust; no platform user exists yet.']
          : []),
        purgeResources
          ? purgeResourcesPlanText(manifest)
          : [
              'Disable platform traffic.',
              retainData
                ? 'Keep Workers and data.'
                : 'Delete eligible data; keep Workers, R2, and AI Gateway.',
              'Delete unused Queues.',
              ...describeKeptResources(
                manifest,
                plannedKeptResources(manifest, retainData, hasRoutingCheckpoint),
                'Keep for manual cleanup:',
                'Keep Access resources:',
              ),
            ].join('\n'),
      ].join('\n'),
      pc.bold('Uninstall plan'),
    );
  }
  if (purgeResources) {
    const credentialCheck = checkPurgeResourcesCredentials(
      client,
      manifest,
      dependencies.credential ?? { source: 'environment', aiGatewayToken: false },
    );
    if (args.plan) {
      await credentialCheck.catch((error: unknown) => {
        log.warn(error instanceof Error ? error.message : String(error));
      });
    } else {
      await credentialCheck;
    }
  }
  if (args.plan) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
  }
  if (interactive && !args.yes) {
    const proceed = await confirmAction(
      purgeResources
        ? 'Permanently delete every Cloudflare resource this installation created?'
        : args.purgeData
          ? 'Permanently purge installer-owned platform data?'
          : 'Uninstall this platform?',
      false,
    );
    if (!proceed) {
      outro('No changes made.');
      return;
    }
  }

  log.step(`Uninstalling ${manifest.deployment.displayName}...`);

  const purgeResourcesKept = new Set(
    purgeResources ? purgeResourcesKeptResources(manifest).map((resource) => resource.key) : [],
  );
  const resourcesToDelete = new Set(
    manifest.resources
      .filter(
        (resource) =>
          (shouldDeleteResource(resource, retainData) ||
            (purgeResources &&
              // Includes what an uninstall that stopped before it finished
              // recorded as retained, so a replaced one stops the run here too.
              (resource.state === 'ready' || isPurgeResourcesCandidate(manifest, resource)) &&
              !purgeResourcesKept.has(resource.key) &&
              isOwnershipVerifiableKind(resource.kind) &&
              // A changed DNS record is kept, not a reason to stop, so it is
              // proven only right before its DELETE.
              resource.kind !== 'dns-record' &&
              // After its ownership marker was removed, the bucket is proven
              // by its creation fingerprint instead.
              !hasLifecycleStep(
                manifest,
                `${PURGE_RESOURCES_STEP_PREFIX}r2-marker:${resource.key}`,
              ))) &&
          (hasRoutingCheckpoint || resource.kind === 'zone') &&
          !(
            resource.kind === 'dns-record' &&
            !manifest.resources.some((entry) => entry.key === 'zone')
          ),
      )
      .map((resource) => resource.key),
  );
  const ownershipTargets = new Set([
    ...(hasRoutingCheckpoint ? ['routing-kv'] : []),
    'zone',
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.key),
    ...resourcesToDelete,
  ]);
  // Ownership checks only look at ready resources. Prove retained ones that
  // --purge-resources reopens the same way, without recording them as ready again.
  const proofManifest = {
    ...manifest,
    resources: manifest.resources.map((resource) =>
      resource.state === 'retained' && resourcesToDelete.has(resource.key)
        ? { ...resource, state: 'ready' as const }
        : resource,
    ),
  };
  let missingResources: ReadonlySet<string>;
  if (hasRoutingCheckpoint) {
    missingResources = await verifyPlatformMutationOwnership(
      client,
      proofManifest,
      ownershipTargets,
      {
        allowDeletedRoutingCheckpoint: args.purgeData,
        databaseUrl: dependencies.databaseUrl,
      },
    );
  } else {
    await verifyPlatformInstallationOwnership(client, manifest, {
      databaseUrl: dependencies.databaseUrl,
    });
    missingResources = new Set();
  }

  // Zero Trust writers and project creation in the API take this lock and
  // never the lifecycle lock. Holding it from the final check until traffic is
  // disabled keeps them from creating Access applications or projects the
  // check did not see. A request admitted before the disable may already be
  // waiting on the lock, so the fence makes every later holder refuse. Only
  // enabling the platform again lifts it once the disable write has started.
  const { fenceProjectZeroTrust, liftProjectZeroTrustFence, lockProjectZeroTrust } = dependencies;
  if (!lockProjectZeroTrust || !fenceProjectZeroTrust || !liftProjectZeroTrustFence) {
    throw new Error(
      'platform: Refusing to uninstall because no platform database connection is available to hold off project Zero Trust changes.',
    );
  }
  if (zeroTrust) {
    // The API takes the Zero Trust lock to turn it off, so this runs before
    // uninstall takes that lock. The final check below then reads the result.
    log.step('Turning off project Zero Trust');
    await dependencies.turnOffProjectZeroTrust!();
  }
  const releaseProjectZeroTrust = await lockProjectZeroTrust();
  let fenced = false;
  let disablingTraffic = false;
  const stopProjectZeroTrustHold = async () => {
    if (fenced && !disablingTraffic) {
      await liftProjectZeroTrustFence().catch((error: unknown) => {
        log.warn(
          `Could not reopen project Zero Trust changes after the uninstall stopped: ${error instanceof Error ? error.message : String(error)}\nRun \`void platform uninstall\` again, or \`void platform repair\` to keep the platform.`,
        );
      });
    }
    await releaseProjectZeroTrust();
  };
  let next = manifest;
  try {
    await assertProjectZeroTrustAllowsUninstall(dependencies.readProjectZeroTrust);
    if (purgeResources) {
      await assertNoPlatformProjects(dependencies.readProjects);
    }
    fenced = true;
    await fenceProjectZeroTrust();
    next = transitionInstallation(manifest, 'uninstalling', new Date().toISOString());
    writeInstallationManifest(next);
  } catch (error) {
    await stopProjectZeroTrustHold();
    throw error;
  }
  try {
    await saveRemoteManifest(next);
    const routing = hasRoutingCheckpoint ? requireResource(next, 'routing-kv') : undefined;
    disablingTraffic = true;
    if (routing) {
      await client.putKvValue(
        next.account.id,
        routing.id,
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
    }
    await releaseProjectZeroTrust();
    for (const key of missingResources) {
      const resource = requireResource(next, key);
      next = updateResourceState(
        next,
        key,
        resource.ownership === 'created' ? 'deleted' : 'retained',
      );
      await saveCheckpoint(next);
    }
    const workers = new Set(
      next.resources
        .filter((resource) => resource.kind === 'worker' && resource.state === 'ready')
        .map((resource) => resource.name),
    );
    const zone = next.resources.find((resource) => resource.key === 'zone');
    if (zone?.state === 'ready') {
      for (const worker of next.resources.filter(
        (resource) =>
          resource.kind === 'worker' && resource.state === 'ready' && workers.has(resource.name),
      )) {
        const missing = await verifyPlatformMutationOwnership(
          client,
          next,
          new Set(['routing-kv', 'zone', worker.key]),
          { databaseUrl: dependencies.databaseUrl },
        );
        if (!missing.has(worker.key)) {
          next = markTrafficAttachmentsRetained(next);
          next = recordLifecycleStep(next, `uninstall:routes:${worker.key}`);
          await saveCheckpoint(next);
        }
      }
    }
    if (purgeResources && hasRoutingCheckpoint) {
      next = await runPurgeResourcesTeardown(
        {
          client,
          checkpoint: async (checkpointManifest) => {
            // Keep `next` current so a failure records the progress made.
            next = checkpointManifest;
            await saveCheckpoint(checkpointManifest);
          },
          verify: (checkpointManifest, keys) =>
            verifyPlatformMutationOwnership(client, checkpointManifest, keys, {
              allowDeletedRoutingCheckpoint: true,
              databaseUrl: dependencies.databaseUrl,
            }),
          bucketGeneration: async (checkpointManifest, bucket) => {
            const live = (await client.listR2Buckets(checkpointManifest.account.id)).find(
              (entry) => entry.id === bucket.id && entry.name === bucket.name,
            );
            if (!live) {
              return null;
            }
            return live.fingerprint === undefined
              ? 'unknown'
              : r2BucketConfigHash(bucket.name, live.fingerprint);
          },
          // --purge-resources already refused unless the project list could be read.
          readProjects: () => dependencies.readProjects!(),
        },
        next,
      );
    }
    const deletionPriority: Record<string, number> = {
      worker: 0,
      queue: 1,
      'ai-gateway': 2,
      'dns-record': 3,
      'dispatch-namespace': 4,
      hyperdrive: 5,
      'kv-namespace': 6,
      'r2-bucket': 7,
      zone: 8,
    };
    const resources = [...next.resources].sort(
      (left, right) =>
        resourceDeletionPriority(left, deletionPriority) -
        resourceDeletionPriority(right, deletionPriority),
    );
    // Uninstall retains Workers, and Cloudflare refuses to delete a Queue that
    // a Worker still binds. Delete Queues only once none of this installation's
    // Workers exist, so a retained Worker keeps its bindings intact.
    const queuesInUse =
      hasRoutingCheckpoint &&
      resources.some(
        (resource) => resource.kind === 'queue' && shouldDeleteResource(resource, retainData),
      ) &&
      (await hasLiveInstallationWorker(client, next));
    for (const listed of resources) {
      // Routing KV that a stopped uninstall retained is deleted last, like a ready one.
      const resource =
        reopenedRouting && listed.key === 'routing-kv'
          ? { ...listed, state: 'ready' as const }
          : listed;
      if (resource.state !== 'ready') {
        continue;
      }
      if (!hasRoutingCheckpoint && resource.kind !== 'zone') {
        next = updateResourceState(next, resource.key, 'retained');
        await saveCheckpoint(next);
        continue;
      }
      if (!shouldDeleteResource(resource, retainData)) {
        // AI Gateway is never deleted, but one already removed in Cloudflare
        // is not left behind, so record it like other missing resources.
        const removed =
          resource.kind === 'ai-gateway' &&
          resource.ownership === 'created' &&
          !hasNamedResource(await client.listAiGateways(next.account.id), resource);
        next = updateResourceState(next, resource.key, removed ? 'deleted' : 'retained');
        await saveCheckpoint(next);
        continue;
      }
      if ((resource.kind === 'dns-record' && !zone) || (resource.kind === 'queue' && queuesInUse)) {
        next = updateResourceState(next, resource.key, 'retained');
        await saveCheckpoint(next);
        continue;
      }
      const immediatelyMissing = await verifyPlatformMutationOwnership(
        client,
        next,
        new Set(['routing-kv', resource.key]),
        {
          allowDeletedRoutingCheckpoint: args.purgeData,
          databaseUrl: dependencies.databaseUrl,
        },
      );
      if (immediatelyMissing.has(resource.key)) {
        next = updateResourceState(
          next,
          resource.key,
          resource.ownership === 'created' ? 'deleted' : 'retained',
        );
        await saveCheckpoint(next);
        continue;
      }
      await client.deleteResource(next.account.id, resource, zone?.id);
      next = updateResourceState(next, resource.key, 'deleted');
      await saveCheckpoint(next);
    }
    const completed = transitionInstallation(next, 'uninstalled', new Date().toISOString());
    await saveRemoteManifest(completed);
    next = completed;
    writeInstallationManifest(completed);
    if (!retainData) {
      removeInstallationRecoverySecrets(next);
    }
    removePlatformConnectionForInstallation(next.id);
    const kept = describeKeptResources(
      next,
      next.resources.filter((resource) => resource.state === 'retained'),
      'Cloudflare resources:',
      'Access resources:',
      purgeResources && purgeResourcesHandlesEmailRouting(next),
    );
    if (kept.length) {
      note(kept.join('\n'), pc.bold('Kept resources'));
    }
    printSuccess(`Uninstalled ${next.deployment.displayName}.`);
  } catch (error) {
    await stopProjectZeroTrustHold().catch(() => {});
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    await saveRemoteManifest(next).catch(() => {});
    throw error;
  }
}

export async function recoverDurablyMarkedProvisionIntents(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest> {
  const candidates = [
    ['api-worker', 'worker', manifest.deployment.resources.apiWorker],
    ['proxy-worker', 'worker', manifest.deployment.resources.proxyWorker],
    ['email-gateway-worker', 'worker', manifest.deployment.resources.emailGatewayWorker],
    ['tail-worker', 'worker', manifest.deployment.resources.tailWorker],
    ['dispatch-worker', 'worker', manifest.deployment.resources.dispatchWorker],
    ['assets-bucket', 'r2-bucket', manifest.deployment.resources.assetsBucket],
  ] as const;
  const pending = candidates.filter(
    ([key, kind, name]) =>
      !manifest.resources.some((resource) => resource.key === key) &&
      hasProvisionIntentStep(manifest, key, kind, name),
  );
  if (pending.length === 0) {
    return manifest;
  }
  const [workers, buckets] = await Promise.all([
    client.listWorkerNames(manifest.account.id),
    client.listR2Buckets(manifest.account.id),
  ]);
  let recovered = manifest;
  for (const [key, kind, name] of pending) {
    const live =
      kind === 'worker'
        ? workers.includes(name)
          ? { id: name, name }
          : null
        : (buckets.find((bucket) => bucket.name === name) ?? null);
    if (!live) {
      continue;
    }
    const resource: InstallationResource = {
      configHash: legacyResourceConfigHash(kind, name),
      id: live.id,
      key,
      kind,
      name,
      ownership: 'created',
      state: 'ready',
    };
    const marker =
      kind === 'worker'
        ? (await client.getWorkerPlainTextBindings(manifest.account.id, name))
            .PLATFORM_OWNERSHIP_MARKER
        : await client.getR2Object(manifest.account.id, name, PLATFORM_R2_OWNERSHIP_MARKER_KEY);
    verifyResourceMarker(marker, manifest, resource);
    recovered = recordInstallationResource(recovered, resource, manifest.updatedAt);
  }
  return recovered;
}

const DATA_RESOURCE_KINDS = new Set([
  'ai-gateway',
  'dispatch-namespace',
  'hyperdrive',
  'kv-namespace',
  'r2-bucket',
]);

function isOwnershipVerifiableKind(kind: InstallationResource['kind']): boolean {
  return (
    kind === 'ai-gateway' ||
    kind === 'dispatch-namespace' ||
    kind === 'dns-record' ||
    kind === 'hyperdrive' ||
    kind === 'kv-namespace' ||
    kind === 'queue' ||
    kind === 'r2-bucket' ||
    kind === 'worker' ||
    kind === 'zone'
  );
}

// Kinds in the order of the manual cleanup steps in the uninstall guide. The
// tail Worker is listed after the dispatch namespace (see keptResourceRank),
// because Cloudflare refuses to delete it while other Workers send it logs.
const KEPT_RESOURCE_ORDER: ReadonlyArray<InstallationResourceKind> = [
  'dns-record',
  'worker-route',
  'worker-custom-domain',
  'queue',
  'worker',
  'dispatch-namespace',
  'kv-namespace',
  'hyperdrive',
  'r2-bucket',
  'ai-gateway',
  'analytics-dataset',
  'zone',
];

/** Resources an uninstall with these options leaves in the account. */
function plannedKeptResources(
  manifest: PlatformInstallationManifest,
  retainData: boolean,
  hasRoutingCheckpoint: boolean,
): Array<InstallationResource> {
  // Uninstall never deletes Workers, and Queues are deleted only once no
  // installation Worker remains.
  const workersRemain = manifest.resources.some(
    (resource) => resource.kind === 'worker' && resource.state === 'ready',
  );
  return manifest.resources.filter(
    (resource) =>
      resource.state === 'retained' ||
      (resource.state === 'ready' &&
        ((!hasRoutingCheckpoint && resource.kind !== 'zone') ||
          !shouldDeleteResource(resource, retainData) ||
          (resource.kind === 'queue' && workersRemain))),
  );
}

function keptResourceRank(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): number {
  return isPlatformTailWorker(manifest, resource)
    ? KEPT_RESOURCE_ORDER.indexOf('dispatch-namespace') + 0.5
    : KEPT_RESOURCE_ORDER.indexOf(resource.kind);
}

function purgeResourcesPlanText(manifest: PlatformInstallationManifest): string {
  const permissions = purgeResourcesPermissions(manifest);
  // Created Access resources are deleted unless an earlier run kept them.
  const keepManifest = {
    ...manifest,
    authenticationResources: (manifest.authenticationResources ?? []).filter(
      (resource) =>
        resource.ownership !== 'created' ||
        purgeResourcesKeptReason(manifest, `access:${resource.key}`) !== null,
    ),
  };
  return [
    'Disable platform traffic.',
    ...describePurgeResourcesPlan(manifest),
    ...describeKeptResources(
      keepManifest,
      purgeResourcesKeptResources(manifest),
      'Keep for manual cleanup:',
      'Keep Access resources you connected:',
      purgeResourcesHandlesEmailRouting(manifest),
    ),
    'Always kept:',
    ...purgeResourcesAlwaysKept(),
    ...(permissions.length
      ? [
          `API token needs: ${permissions.join(', ')}. Browser login cannot delete DNS records or Access resources.`,
        ]
      : []),
  ].join('\n');
}

function describeKeptResources(
  manifest: PlatformInstallationManifest,
  resources: ReadonlyArray<InstallationResource>,
  heading: string,
  accessHeading: string,
  /** --purge-resources removes the Email Routing rules that send mail to the gateway Worker. */
  emailRulesRemoved = false,
): Array<string> {
  const sorted = [...resources].sort(
    (left, right) => keptResourceRank(manifest, left) - keptResourceRank(manifest, right),
  );
  const isTraffic = (resource: InstallationResource) =>
    KEPT_RESOURCE_ORDER.indexOf(resource.kind) < KEPT_RESOURCE_ORDER.indexOf('queue');
  const why = (key: string) => {
    const reason = purgeResourcesKeptReason(manifest, key);
    return reason === null ? '' : `, kept because ${reason}`;
  };
  const line = (resource: InstallationResource) =>
    `  ${resource.kind}: ${resource.name}${resource.name === resource.id ? '' : ` (${resource.id})`}${why(resource.key)}`;
  const {
    capabilities,
    emailSenderDomain,
    emailSharedZoneId,
    resources: names,
  } = manifest.deployment;
  // Email Routing is set up through the platform API and is not a manifest
  // resource. Its rules point at the email gateway Worker, so it comes before
  // the Workers.
  const email = capabilities.email
    ? [
        emailRulesRemoved && emailSenderDomain
          ? `  Email Routing for ${emailSenderDomain} (zone ${emailSharedZoneId}): its settings and the sender domain's MX, SPF, and DKIM records.`
          : emailSenderDomain
            ? `  Email Routing for ${emailSenderDomain} (zone ${emailSharedZoneId}): its routing DNS records and any catch-all rule that sends mail to ${names.emailGatewayWorker}.`
            : `  Email Routing: any catch-all rule that sends mail to ${names.emailGatewayWorker}.`,
      ]
    : [];
  const remainingAccess = (manifest.authenticationResources ?? []).filter(
    (resource) => !isPurgedAccessResource(manifest, resource),
  );
  const accessLine = (resource: (typeof remainingAccess)[number]) =>
    `  ${resource.ownership} ${resource.kind}: ${resource.name} (${resource.id}, account ${resource.accountId})${why(`access:${resource.key}`)}`;
  // Access resources --purge-resources kept because they changed are listed with the
  // other kept resources, not as ones the operator connected.
  const keptAccess = (resource: (typeof remainingAccess)[number]) =>
    purgeResourcesKeptReason(manifest, `access:${resource.key}`) !== null;
  const kept = [
    ...sorted.filter(isTraffic).map(line),
    ...remainingAccess.filter(keptAccess).map(accessLine),
    ...email,
    ...sorted.filter((resource) => !isTraffic(resource)).map(line),
  ];
  const access = remainingAccess.filter((resource) => !keptAccess(resource)).map(accessLine);
  return [
    ...(kept.length ? [heading, ...kept] : []),
    ...(access.length ? [accessHeading, ...access] : []),
  ];
}

function shouldDeleteResource(resource: InstallationResource, retainData: boolean): boolean {
  if (resource.state !== 'ready' || resource.ownership !== 'created') {
    return false;
  }
  if (resource.kind === 'zone') {
    return false;
  }
  // AI Gateway ids are caller-selected and can be reused after deletion. The
  // API exposes no durable ownership marker, so automatic deletion could
  // remove a replacement gateway created by another installation.
  if (resource.kind === 'ai-gateway') {
    return false;
  }
  // DNS record deletion is id-addressed but Cloudflare exposes no conditional
  // delete tied to the exact type/content/proxy tuple we verified. A dashboard
  // edit can retain the id while repurposing the record, so keep it for manual
  // cleanup instead of racing an unrelated production record.
  if (resource.kind === 'dns-record') {
    return false;
  }
  // Cloudflare exposes no server-enforced condition tying object deletion to
  // an R2 bucket generation. A same-name replacement can therefore race any
  // client-side ownership recheck. Retain R2 even during --purge-data and
  // require the operator to remove it explicitly in the Cloudflare dashboard.
  if (resource.kind === 'r2-bucket') {
    return false;
  }
  // Worker lifecycle mutations are name-addressed. Cloudflare exposes no
  // generation precondition that can prevent a same-name replacement from
  // racing the final ownership check, so retain Workers for manual cleanup.
  if (resource.kind === 'worker') {
    return false;
  }
  // Traffic attachments are removed only through their immutable Cloudflare
  // ids after tuple validation. Never pass an untracked or stale attachment to
  // the generic resource deleter.
  if (resource.kind === 'worker-route' || resource.kind === 'worker-custom-domain') {
    return false;
  }
  return !(retainData && DATA_RESOURCE_KINDS.has(resource.kind));
}

async function hasLiveInstallationWorker(
  client: Pick<PlatformManagementClient, 'listWorkerNames'>,
  manifest: PlatformInstallationManifest,
): Promise<boolean> {
  const names = manifest.deployment.resources;
  const installationWorkers = new Set([
    names.apiWorker,
    names.proxyWorker,
    names.emailGatewayWorker,
    names.tailWorker,
    names.dispatchWorker,
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.name),
  ]);
  return (await client.listWorkerNames(manifest.account.id)).some((name) =>
    installationWorkers.has(name),
  );
}

function resourceDeletionPriority(
  resource: InstallationResource,
  priorities: Readonly<Record<string, number>>,
): number {
  // The routing namespace contains the authoritative ownership checkpoint.
  // Delete it last so interrupted purges can still prove every earlier mutation.
  return resource.key === 'routing-kv' ? 100 : (priorities[resource.kind] ?? 99);
}

async function verifyPlatformMutationOwnership(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
  options: {
    allowDeletedRoutingCheckpoint?: boolean;
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
    databaseUrl?: string;
  } = {},
): Promise<ReadonlySet<string>> {
  const routing = requireResource(manifest, 'routing-kv');
  const targetResources = manifest.resources.filter(
    (resource) => targetKeys.has(resource.key) && resource.state === 'ready',
  );
  let rawRemote: string | null = null;
  let remote: PlatformInstallationManifest | null = null;
  let replacingMissingRoutingCheckpoint = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    rawRemote = await client.getKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (rawRemote !== null) {
      try {
        remote = parsePlatformInstallationManifest(JSON.parse(rawRemote) as unknown);
      } catch {
        throw ownershipError('the remote installation checkpoint is invalid');
      }
      if (
        remote.id !== manifest.id ||
        remote.ownershipNonce !== manifest.ownershipNonce ||
        remote.account.id !== manifest.account.id
      ) {
        throw ownershipError('the remote installation identity does not match this installation');
      }
      if (targetResources.every((resource) => hasMatchingResourceProof(remote!, resource))) {
        break;
      }
    }
    if (attempt < 2) {
      await delay(50 * 2 ** attempt);
    }
  }
  if (rawRemote === null) {
    if (
      (options.allowMissingRoutingCheckpoint || options.allowUninitializedRoutingCheckpoint) &&
      routing.ownership === 'created'
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      const routingMatches = namespaces.some(
        (entry) => entry.id === routing.id && entry.name === routing.name,
      );
      const routingIdentityCollides = namespaces.some(
        (entry) => entry.id === routing.id || entry.name === routing.name,
      );
      if (
        (options.allowMissingRoutingCheckpoint && !routingIdentityCollides) ||
        (options.allowUninitializedRoutingCheckpoint && routingMatches)
      ) {
        // The caller holds the authoritative PostgreSQL lifecycle lock. Repair
        // or resume may use that manifest as the replacement checkpoint, but
        // every surviving resource must still pass fresh inventory and marker
        // checks. An existing routing namespace is accepted only with the
        // exact id and name recorded by the database-authoritative manifest.
        remote = manifest;
        replacingMissingRoutingCheckpoint = true;
      }
    }
    if (
      !replacingMissingRoutingCheckpoint &&
      options.allowDeletedRoutingCheckpoint &&
      canResumeAfterRoutingCheckpointDeletion(manifest, targetKeys)
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      if (!namespaces.some((entry) => entry.id === routing.id)) {
        return new Set([routing.key]);
      }
    }
    if (!replacingMissingRoutingCheckpoint) {
      throw ownershipError('the remote installation checkpoint is missing');
    }
  }
  if (!remote) {
    throw ownershipError('the remote installation checkpoint is missing');
  }

  const localAdvancesRemote = isPlatformManifestMonotonicExtension(remote, manifest);
  for (const resource of targetResources) {
    const proof = remote.resources.find((entry) => entry.key === resource.key);
    if (!hasMatchingResourceProof(remote, resource)) {
      if (
        !proof &&
        localAdvancesRemote &&
        resource.kind !== 'ai-gateway' &&
        hasMatchingResourceIntent(remote, resource)
      ) {
        continue;
      }
      throw ownershipError(`the remote checkpoint does not own ${resource.kind} ${resource.name}`);
    }
  }

  const missing = new Set<string>(replacingMissingRoutingCheckpoint ? [routing.key] : []);
  const accountId = manifest.account.id;
  const zone = manifest.resources.find((resource) => resource.key === 'zone');
  const inventory = await Promise.all([
    client.listAiGateways(accountId),
    // Workers for Platforms is a paid product; list namespaces only when one
    // is being checked.
    targetResources.some((resource) => resource.kind === 'dispatch-namespace')
      ? client.listDispatchNamespaces(accountId)
      : Promise.resolve([]),
    client.listHyperdriveConfigs(accountId),
    client.listKvNamespaces(accountId),
    client.listR2Buckets(accountId),
    client.listWorkerNames(accountId),
  ]);
  const [aiGateways, dispatchNamespaces, hyperdrives, kvNamespaces, r2Buckets, workerNames] =
    inventory;

  for (const resource of targetResources) {
    let exists = true;
    if (resource.kind === 'ai-gateway') {
      exists = hasNamedResource(aiGateways, resource);
    } else if (resource.kind === 'dispatch-namespace') {
      exists = hasNamedResource(dispatchNamespaces, resource);
    } else if (resource.kind === 'hyperdrive') {
      exists = hasNamedResource(hyperdrives, resource);
      if (exists) {
        const live = await client.getHyperdriveConfig(accountId, resource.id);
        exists = live.id === resource.id && live.name === resource.name;
        if (exists) {
          const legacyHash = legacyResourceConfigHash(resource.kind, resource.name);
          const malformedLegacyHash = !/^[a-f0-9]{64}$/.test(resource.configHash);
          if (options.databaseUrl && resource.ownership !== 'adopted') {
            const expected = hyperdriveOriginFromConnectionString(options.databaseUrl);
            if (!hyperdriveOriginMatches(live.origin, expected)) {
              throw ownershipError(
                `hyperdrive ${resource.name} targets a different PostgreSQL origin than this installation's pinned database`,
              );
            }
            const expectedHash = hyperdriveOriginConfigHash(expected);
            if (
              resource.configHash !== expectedHash &&
              resource.configHash !== legacyHash &&
              !malformedLegacyHash
            ) {
              throw ownershipError(
                `hyperdrive ${resource.name} does not match the installation's database fingerprint`,
              );
            }
          } else if (
            resource.ownership === 'adopted' &&
            (resource.configHash !== hyperdriveOriginConfigHash(live.origin) ||
              (options.databaseUrl &&
                live.origin.database !== platformDatabaseNameFromOwnerUrl(options.databaseUrl)))
          ) {
            throw ownershipError(`hyperdrive ${resource.name} changed configuration`);
          } else if (
            resource.ownership !== 'adopted' &&
            resource.configHash !== hyperdriveOriginConfigHash(live.origin) &&
            resource.configHash !== legacyHash &&
            !malformedLegacyHash
          ) {
            throw ownershipError(`hyperdrive ${resource.name} changed configuration`);
          }
        }
      }
    } else if (resource.kind === 'kv-namespace') {
      exists = hasNamedResource(kvNamespaces, resource);
    } else if (resource.kind === 'queue') {
      exists = hasNamedResource(await client.listQueues(accountId, resource.name), resource);
    } else if (resource.kind === 'zone') {
      const current = await client.findZone(accountId, resource.name);
      exists = current?.id === resource.id;
    } else if (resource.kind === 'dns-record') {
      if (!zone) {
        exists = false;
      } else {
        const current = (await client.listDnsRecords(zone.id, resource.name)).find(
          (entry) => entry.id === resource.id && entry.name === resource.name,
        );
        exists = current !== undefined;
        if (current && resource.ownership === 'created') {
          const liveHash = dnsRecordConfigHash(
            current.name,
            current.type,
            current.content,
            current.proxied,
          );
          const legacyHash = legacyResourceConfigHash(resource.kind, resource.name);
          const expectedHash = dnsRecordConfigHash(resource.name, 'AAAA', '100::', true);
          if (
            liveHash !== resource.configHash &&
            !(resource.configHash === legacyHash && liveHash === expectedHash)
          ) {
            throw new PlatformResourceChangedError(
              resource.key,
              'its configuration changed after installation',
              ownershipError(`dns-record ${resource.name} changed configuration after installation`)
                .message,
            );
          }
        }
      }
    } else if (resource.kind === 'worker') {
      exists = workerNames.includes(resource.name);
      if (exists) {
        const bindings = await client.getWorkerPlainTextBindings(accountId, resource.name);
        verifyResourceMarker(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, resource);
      }
    } else if (resource.kind === 'r2-bucket') {
      const live = r2Buckets.find(
        (entry) => entry.id === resource.id && entry.name === resource.name,
      );
      exists = live !== undefined;
      if (live) {
        if (!matchesRecordedR2Fingerprint(resource.configHash, live)) {
          throw ownershipError(`r2-bucket ${resource.name} changed creation fingerprint`);
        }
        const marker = await client.getR2Object(
          accountId,
          resource.name,
          PLATFORM_R2_OWNERSHIP_MARKER_KEY,
        );
        verifyResourceMarker(marker, manifest, resource);
      }
    } else {
      throw ownershipError(`live ownership checks do not support ${resource.kind}`);
    }
    if (!exists) {
      missing.add(resource.key);
    }
  }
  return missing;
}

function hasMatchingResourceProof(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  const proof = manifest.resources.find((entry) => entry.key === resource.key);
  return (
    proof?.id === resource.id &&
    proof.kind === resource.kind &&
    proof.name === resource.name &&
    proof.ownership === resource.ownership
  );
}

function hasMatchingResourceIntent(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  if (resource.ownership === 'created') {
    return hasProvisionIntentStep(manifest, resource.key, resource.kind, resource.name);
  }
  if (resource.ownership === 'adopted') {
    return manifest.steps.some(
      (step) =>
        step.key === `adoption-intent:${resource.key}` &&
        step.resultHash ===
          platformAdoptionIntentHash(
            manifest,
            resource.key,
            resource.kind,
            resource.id,
            resource.name,
          ),
    );
  }
  return false;
}

export function isPlatformManifestMonotonicExtension(
  earlier: PlatformInstallationManifest,
  later: PlatformInstallationManifest,
): boolean {
  if (
    earlier.id !== later.id ||
    earlier.ownershipNonce !== later.ownershipNonce ||
    earlier.account.id !== later.account.id ||
    earlier.createdAt !== later.createdAt ||
    JSON.stringify(earlier.deployment) !== JSON.stringify(later.deployment) ||
    Date.parse(later.updatedAt) < Date.parse(earlier.updatedAt)
  ) {
    return false;
  }
  const resourcesAdvance = earlier.resources.every((resource) => {
    const next = later.resources.find((entry) => entry.key === resource.key);
    return (
      next?.id === resource.id &&
      next.kind === resource.kind &&
      next.name === resource.name &&
      next.ownership === resource.ownership &&
      (next.state === resource.state ||
        (resource.state === 'ready' && (next.state === 'deleted' || next.state === 'retained')) ||
        // --purge-resources deletes routes and custom domains recorded as retained.
        (resource.state === 'retained' && next.state === 'deleted'))
    );
  });
  const stepsAdvance = earlier.steps.every((step) =>
    later.steps.some(
      (entry) =>
        entry.key === step.key &&
        entry.completedAt === step.completedAt &&
        entry.resultHash === step.resultHash,
    ),
  );
  const authenticationResourcesAdvance = (earlier.authenticationResources ?? []).every((resource) =>
    (later.authenticationResources ?? []).some(
      (next) => JSON.stringify(next) === JSON.stringify(resource),
    ),
  );
  return resourcesAdvance && stepsAdvance && authenticationResourcesAdvance;
}

function hasNamedResource(
  entries: ReadonlyArray<{ id: string; name: string }>,
  resource: InstallationResource,
): boolean {
  return entries.some((entry) => entry.id === resource.id && entry.name === resource.name);
}

function verifyResourceMarker(
  value: string | null | undefined,
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): void {
  const problem = resourceMarkerProblem(value, manifest, resource);
  if (problem) {
    throw ownershipError(`${resource.kind} ${resource.name} ${problem}`);
  }
}

function canResumeAfterRoutingCheckpointDeletion(
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
): boolean {
  if (manifest.status !== 'failed' && manifest.status !== 'uninstalling') {
    return false;
  }
  return manifest.resources.every(
    (resource) =>
      resource.key === 'routing-kv' || !targetKeys.has(resource.key) || resource.state !== 'ready',
  );
}

function ownershipError(reason: string): Error {
  return new Error(
    `platform: Refusing to change Cloudflare resources because ${reason}. Run \`void platform repair\` to restore ownership proofs before retrying.`,
  );
}

function requireResource(manifest: PlatformInstallationManifest, key: string) {
  const resource = manifest.resources.find((entry) => entry.key === key);
  if (!resource) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return resource;
}

function updateResourceState(
  manifest: PlatformInstallationManifest,
  key: string,
  state: 'deleted' | 'retained',
): PlatformInstallationManifest {
  const resource = requireResource(manifest, key);
  return recordInstallationResource(manifest, { ...resource, state }, new Date().toISOString());
}

// Cloudflare has no precondition for route or custom domain deletion, so even a
// checked record id can be reused before DELETE. The routing KV gate blocks
// traffic instead, and attachments stay for dashboard cleanup.
function markTrafficAttachmentsRetained(
  manifest: PlatformInstallationManifest,
): PlatformInstallationManifest {
  let next = manifest;
  for (const resource of manifest.resources) {
    if (
      resource.state === 'ready' &&
      (resource.kind === 'worker-route' || resource.kind === 'worker-custom-domain')
    ) {
      next = updateResourceState(next, resource.key, 'retained');
    }
  }
  return next;
}

function hasLifecycleStep(manifest: PlatformInstallationManifest, key: string): boolean {
  return manifest.steps.some((step) => step.key === key);
}

function currentTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return Math.max(
    0,
    ...manifest.steps.flatMap((step) => {
      const match = /^traffic-enabled:(\d+)$/.exec(step.key);
      return match ? [Number(match[1])] : [];
    }),
  );
}

function recordLifecycleStep(
  manifest: PlatformInstallationManifest,
  key: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  return recordInstallationStep(manifest, { completedAt: now, key, resultHash: 'completed' }, now);
}

async function writeLifecycleCheckpoint(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  writeInstallationManifest(manifest);
  await writeRemoteManifest(client, manifest, databaseCheckpoint);
}

async function writeRemoteManifest(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  await databaseCheckpoint?.(manifest);
  const routing = manifest.resources.find(
    (resource) => resource.key === 'routing-kv' && resource.state !== 'deleted',
  );
  if (routing) {
    await client.putKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
      JSON.stringify(manifest),
    );
  }
}

async function promptForConfirmation(message: string, initialValue: boolean): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer) || typeof answer === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return answer;
}
