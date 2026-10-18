import { randomBytes } from 'node:crypto';
import {
  createPlatformResourceNames,
  normalizeApplicationDomain,
  normalizeInstallationSlug,
  type PlatformInstallationManifest,
} from '@void/platform';
import {
  confirm,
  isCancel,
  log,
  outro,
  password,
  select,
  text,
} from '@voidzero-dev/vite-plus-prompts';
import { resolve } from 'pathslash';
import { printSuccess, cliCommandName, createSpinner, formatUrl, note, pc } from './output.ts';
import {
  selectInstallationAppAccess,
  prepareInstallationAppAccess,
} from './platform-app-access.ts';
import type { PlatformArgs } from './platform-args.ts';
import { readPlatformHyperdriveSelection } from './platform-auth-database.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  platformOperatorNeedsManagementToken,
  verifyPlatformManagementAccess,
  resolvePlatformCloudflareCredential,
  resolvePlatformCloudflareCredentialWithInput,
} from './platform-auth.ts';
import {
  PlatformCloudflareClient,
  PlatformCloudflareApiError,
  PlatformRuntimeTokenEmailPermissionError,
  verifyPlatformRuntimeTokenPermissions,
  type CloudflareAccount,
} from './platform-cloudflare.ts';
import {
  selectInstallationAuthentication,
  collectInstallationAuthentication,
  platformManagementAccessForAuthentication,
} from './platform-install-auth.ts';
import {
  reviewPlatformWorkerOutsideChanges,
  uploadPlatformWorkerOutsideChanges,
} from './platform-installer-outside-changes.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  claimPlatformDatabase,
  createPlatformInstallationSecrets,
  installPlatform,
  loadPlatformRuntime,
  PlatformAccessBlockedError,
  readPlatformDatabaseLifecycleManifest,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  revalidatePlatformInstallAction,
  type PlatformExternalHyperdrive,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  assertPlatformInstallationSlugAvailable,
  listInstallationManifests,
  readInstallationRecoverySecrets,
  readPendingInstallationSecrets,
  resolveInstallationManifest,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import {
  listSavedPlatformInstallPlans,
  savePlatformInstallChoices,
  removeSavedPlatformInstallPlan,
} from './platform-saved-plans.ts';
import {
  completePlatformSetupDraft,
  isPlatformSetupDraft,
  isPlatformInstallInProgress,
  savePlatformSetupDraft,
} from './platform-setup-draft.ts';
import {
  formatPlatformInstallCommand,
  formatPlatformSetupPlan,
  openPlatformSetupPage,
  platformManagementSetupPage,
  platformInstallCommandArguments,
  platformSetupPages,
  platformSetupFieldHelp,
  platformSetupLink,
} from './platform-setup.ts';

function isPlatformInstallDatabaseBound(
  checkpoint: Record<string, string> | null,
  manifest: PlatformInstallationManifest | null,
): boolean {
  return Boolean(
    checkpoint?.databaseClaimState === 'claimed' ||
    manifest?.resources.some(
      (resource) =>
        resource.state === 'ready' &&
        (resource.kind === 'hyperdrive' || resource.kind === 'worker'),
    ) ||
    manifest?.steps.some(
      (step) =>
        step.key.startsWith('database-schema:') || step.key.startsWith('database-migrations:'),
    ),
  );
}

export function resolvePlatformInstallDatabaseUrl(
  checkpoint: Record<string, string> | null,
  manifest: PlatformInstallationManifest | null = null,
): string {
  const explicit = process.env.VOID_PLATFORM_DATABASE_URL || process.env.DATABASE_URL || '';
  const recorded = checkpoint?.databaseUrl || '';
  if (isPlatformInstallDatabaseBound(checkpoint, manifest)) {
    if (!recorded) {
      if (explicit) {
        // Discovery intentionally recovers no credentials. The database's
        // installation claim and ownership nonce are verified under the
        // advisory lock before any lifecycle mutation, and the live
        // Hyperdrive origin is checked against this URL before redeployment.
        return explicit;
      }
      throw new Error(
        'platform: The claimed PostgreSQL database URL is missing from local recovery state. Export VOID_PLATFORM_DATABASE_URL with the original installation database before continuing.',
      );
    }
    if (explicit && explicit !== recorded) {
      throw new Error(
        'platform: This installation is already bound to its recorded PostgreSQL database. Unset DATABASE_URL and VOID_PLATFORM_DATABASE_URL before resuming; changing databases requires an explicit migration flow.',
      );
    }
    return recorded;
  }
  // A failed initial claim has no Cloudflare resource bound to the database,
  // so explicit operator input may correct an unreachable or mistyped URL.
  return explicit || recorded;
}

export async function runPlatformLifecycleCommand(commandArgs: PlatformArgs): Promise<void> {
  if (commandArgs.subcommand === 'domain') {
    const { runPlatformDomainCommand } = await import('./platform-domain.ts');
    await runPlatformDomainCommand(commandArgs);
    return;
  }
  if (commandArgs.subcommand === 'discover') {
    const credential = await resolvePlatformCloudflareCredential();
    const client = new PlatformCloudflareClient(credential.token);
    const accounts = await readAccounts(client);
    const accountId = await selectAccount(accounts, commandArgs.account);
    const { recoverPlatformInstallations } = await import('./platform-recovery.ts');
    const recovered = await recoverPlatformInstallations(
      client,
      accountId,
      undefined,
      commandArgs.selector,
    );
    if (recovered.length === 0) {
      log.info(`No recoverable Void platform installations were found in ${accountId}.`);
      return;
    }
    for (const manifest of recovered) {
      log.step(
        `Recovered ${manifest.deployment.displayName} (${manifest.id}) at ${manifest.endpoints.apiUrl}.`,
      );
    }
    printSuccess(
      `Recovered ${recovered.length} platform installation${recovered.length === 1 ? '' : 's'}.`,
    );
    return;
  }
  if (commandArgs.subcommand !== 'install') {
    const { runInstalledPlatformCommand } = await import('./platform-management.ts');
    await runInstalledPlatformCommand(commandArgs);
    return;
  }

  let args: Extract<PlatformArgs, { subcommand: 'install' }> = commandArgs;
  let runtime = loadPlatformRuntime(args.runtime);

  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);

  console.log();
  let existing = args.resume ? resolveInstallationManifest(args.name) : null;
  let selectedInstall = false;
  let selectedDraft = false;
  let installationName = args.name;
  const { input: installationSlug, credential: operatorCredential } =
    await resolvePlatformCloudflareCredentialWithInput(async () => {
      let requestedName = args.name;
      const resumableInstalls = () =>
        listInstallationManifests().filter(
          (manifest) =>
            isPlatformInstallInProgress(manifest) &&
            (!args.account ||
              manifest.account.id === args.account ||
              manifest.account.name.toLowerCase() === args.account.toLowerCase()),
        );
      const selectInstall = (manifest: PlatformInstallationManifest) => {
        existing = manifest;
        selectedInstall = true;
        selectedDraft = isPlatformSetupDraft(manifest);
      };
      const assertNewNameAvailable = (slug: string) => {
        const collision = listInstallationManifests().find(
          (manifest) =>
            manifest.status !== 'uninstalled' && manifest.deployment.installationSlug === slug,
        );
        if (collision && !isPlatformInstallInProgress(collision)) {
          throw new Error(
            `platform: ${collision.deployment.displayName} (${slug}) already exists (${collision.status}). Run \`void platform status ${collision.id}\` to inspect it.`,
          );
        }
        assertPlatformInstallationSlugAvailable(slug);
      };
      if (!args.resume && process.stdin.isTTY) {
        const installs = resumableInstalls().filter(
          (manifest) =>
            !args.name ||
            manifest.deployment.installationSlug === normalizeInstallationSlug(args.name),
        );
        const manifests = listInstallationManifests();
        const savedPlans =
          !args.applicationDomain &&
          !args.workersDev &&
          !args.zone &&
          !args.displayName &&
          !args.hyperdrive &&
          !args.controlPlaneDomain &&
          !args.noControlPlaneDomain &&
          !args.authConfig &&
          !args.loginMethods &&
          !args.runtime &&
          args.accessProtection === undefined &&
          args.appAccess === undefined &&
          !args.dedicatedZoneSpecified &&
          args.dashboardUrl === undefined
            ? listSavedPlatformInstallPlans().filter(
                (saved) =>
                  (!args.name || saved.args.name === normalizeInstallationSlug(args.name)) &&
                  (!args.account ||
                    saved.args.account === args.account ||
                    saved.accountName.toLowerCase() === args.account.toLowerCase()) &&
                  !manifests.some(
                    (manifest) =>
                      manifest.status !== 'uninstalled' &&
                      manifest.account.id === saved.args.account &&
                      manifest.deployment.installationSlug === saved.args.name,
                  ),
              )
            : [];
        if (installs.length > 0 || savedPlans.length > 0) {
          const choice = await select({
            message: 'Continue a previous platform install?',
            options: [
              ...installs.map((install) => ({
                value: install.id,
                label: `Continue setup for ${install.deployment.displayName} (${install.deployment.installationSlug})`,
                hint: install.account.name,
              })),
              ...savedPlans.map((saved) => ({
                value: `plan:${saved.id}`,
                label: `Use saved plan for ${saved.args.displayName} (${saved.args.name})`,
                hint: `${saved.accountName} · ${saved.args.workersDev ? 'workers.dev' : saved.args.applicationDomain}`,
              })),
              { value: 'new', label: 'Start a new platform install' },
            ],
          });
          if (isCancel(choice) || typeof choice === 'symbol') {
            throw new Error('platform: Cancelled.');
          }
          if (choice === 'new') {
            // Do not let --name silently reselect the draft the user just declined.
            requestedName = '';
          } else if (choice.startsWith('plan:')) {
            const saved = savedPlans.find((plan) => `plan:${plan.id}` === choice);
            if (!saved) {
              throw new Error('platform: The selected plan is no longer available.');
            }
            args = { ...saved.args, plan: args.plan, yes: args.yes };
            runtime = loadPlatformRuntime(args.runtime);
            installationName = args.name;
            requestedName = args.name;
          } else {
            const selected = installs.find((install) => install.id === choice);
            if (!selected) {
              throw new Error('platform: The selected setup is no longer available.');
            }
            selectInstall(selected);
          }
        }
      }
      while (!existing) {
        const name =
          requestedName ||
          (await promptText('Installation name:', { placeholder: 'company' }, false, (value) => {
            try {
              const slug = normalizeInstallationSlug(value);
              if (
                !resumableInstalls().some((install) => install.deployment.installationSlug === slug)
              ) {
                assertNewNameAvailable(slug);
              }
            } catch (error) {
              return error instanceof Error ? error.message : 'Choose another installation name.';
            }
          }));
        const slug = normalizeInstallationSlug(name);
        const matches = resumableInstalls().filter(
          (install) => install.deployment.installationSlug === slug,
        );
        if (process.stdin.isTTY && matches.length > 0) {
          let selected = matches[0]!;
          if (matches.length > 1) {
            const choice = await select({
              message: `Which ${slug} installation do you want to resume?`,
              options: matches.map((install) => ({
                value: install.id,
                label: install.deployment.displayName,
                hint: install.account.name,
              })),
            });
            if (isCancel(choice) || typeof choice === 'symbol') {
              throw new Error('platform: Cancelled.');
            }
            const matching = matches.find((install) => install.id === choice);
            if (!matching) {
              throw new Error('platform: The selected setup is no longer available.');
            }
            selected = matching;
          }
          const resume = await confirm({
            message: `Resume installation for ${selected.deployment.displayName} (${slug})?`,
            initialValue: true,
          });
          if (isCancel(resume) || typeof resume === 'symbol') {
            throw new Error('platform: Cancelled.');
          }
          if (resume) {
            selectInstall(selected);
          } else {
            requestedName = '';
          }
          continue;
        }
        assertNewNameAvailable(slug);
        installationName = name.trim();
        return slug;
      }
      if (existing.endpoints.apiUrl && !readPendingInstallationSecrets(existing)) {
        throw new Error(
          `platform: Installation ${existing.id} has already been deployed. Use \`void platform repair ${existing.id}\` or \`void platform upgrade ${existing.id}\` instead.`,
        );
      }
      return existing.deployment.installationSlug;
    });
  let client = new PlatformCloudflareClient(operatorCredential.token);
  const accounts = await readAccounts(client);
  const accountId = existing ? existing.account.id : await selectAccount(accounts, args.account);
  if (
    existing &&
    args.account &&
    (await selectAccount(accounts, args.account)) !== existing.account.id
  ) {
    throw new Error('platform: The installation belongs to a different Cloudflare account.');
  }
  const recorded = existing?.deployment;
  if (
    existing &&
    isPlatformSetupDraft(existing) &&
    ((args.applicationDomain &&
      normalizeApplicationDomain(args.applicationDomain) !== recorded!.application.baseDomain) ||
      (args.zone && normalizeApplicationDomain(args.zone) !== recorded!.application.zoneName) ||
      (args.workersDev && !!recorded!.application.zoneName) ||
      (args.controlPlaneDomain &&
        normalizeApplicationDomain(args.controlPlaneDomain) !==
          recorded!.controlPlane.apiHostname) ||
      (args.dedicatedZone && !recorded!.application.dedicatedZone))
  ) {
    throw new Error(
      'platform: These options differ from the saved setup. Resume its recorded configuration or choose another installation name.',
    );
  }
  let workersDev =
    (!!recorded?.application.workersDev && !recorded.application.zoneName) ||
    args.workersDev === true;
  if (
    !recorded &&
    !args.workersDev &&
    !args.applicationDomain &&
    !args.zone &&
    process.stdin.isTTY
  ) {
    const mode = await select({
      message: 'Where should your apps live?',
      options: [
        { value: 'domain', label: 'Use a domain', hint: 'recommended' },
        { value: 'workers-dev', label: 'Use workers.dev for testing', hint: 'add a domain later' },
      ],
    });
    if (isCancel(mode)) {
      throw new Error('platform: Cancelled.');
    }
    workersDev = mode === 'workers-dev';
  }
  const applicationDomain =
    recorded?.application.baseDomain ??
    (workersDev
      ? ''
      : normalizeApplicationDomain(
          args.applicationDomain ||
            (await promptText('Application base domain:', { placeholder: 'example.com' })),
        ));
  const zoneName =
    recorded?.application.zoneName ??
    (workersDev
      ? ''
      : normalizeApplicationDomain(
          args.zone || (await promptText('Cloudflare zone:', applicationDomain)),
        ));
  const displayName =
    recorded?.displayName ??
    (args.displayName ||
      (await promptText('Platform display name:', `${installationName || installationSlug} Void`)));
  let controlPlaneDomain = recorded
    ? (recorded.controlPlane.apiHostname ?? '')
    : args.controlPlaneDomain ||
      (process.stdin.isTTY && !args.noControlPlaneDomain
        ? await promptText(
            'Where do you want to host the Void Platform API? Leave empty for a workers.dev fallback.',
            { placeholder: applicationDomain || 'platform.example.com' },
            true,
          )
        : '');
  let dedicatedZone = recorded?.application.dedicatedZone ?? args.dedicatedZone;
  if (
    !workersDev &&
    !recorded &&
    !args.dedicatedZone &&
    !args.dedicatedZoneSpecified &&
    applicationDomain === zoneName &&
    process.stdin.isTTY
  ) {
    const catchAll = await confirm({
      message: `Dedicate all unmatched ${zoneName} traffic to Void apps?`,
      initialValue: false,
    });
    if (isCancel(catchAll) || typeof catchAll === 'symbol') {
      throw new Error('platform: Cancelled.');
    }
    dedicatedZone = catchAll;
  }
  const release = args.plan ? null : acquirePlatformLifecycleLock(accountId, installationSlug);
  let progress: ReturnType<typeof createSpinner> | undefined;
  const startProgress = (message: string) => {
    const active = createSpinner({
      // Clack stops its animation on cancellation. Forward that cancellation
      // to the CLI's existing signal coordinator (or normal process termination).
      onCancel: () => {
        if (!process.emit('SIGINT')) {
          process.exit(130);
        }
      },
    });
    active.start(message);
    return active;
  };
  // Set while a step uses an unclaimed database URL, which a resume may still replace.
  let usingUnboundDatabase = false;
  try {
    if (!existing && !args.plan) {
      assertPlatformInstallationSlugAvailable(installationSlug);
    }
    if (existing && !args.plan) {
      existing = resolveInstallationManifest(existing.id);
      if (
        selectedInstall &&
        (!isPlatformInstallInProgress(existing) ||
          (selectedDraft && !isPlatformSetupDraft(existing)))
      ) {
        throw new Error(
          'platform: Setup advanced in another process. Rerun with --resume to review its current state.',
        );
      }
    }
    const checkpoint = existing ? readPendingInstallationSecrets(existing) : null;
    const databaseUrl = resolvePlatformInstallDatabaseUrl(checkpoint, existing);
    let authoritativeProvisionIntents = false;
    if (existing && !isPlatformSetupDraft(existing)) {
      if (!databaseUrl) {
        throw new Error(
          'platform: DATABASE_URL is required to verify an interrupted installation before resuming it.',
        );
      }
      progress = startProgress('Reading the saved installation');
      usingUnboundDatabase = !isPlatformInstallDatabaseBound(checkpoint, existing);
      const authoritative = await readPlatformDatabaseLifecycleManifest(
        databaseUrl,
        existing.id,
        existing.ownershipNonce,
      );
      usingUnboundDatabase = false;
      progress?.stop('Read the saved installation.');
      progress = undefined;
      if (authoritative) {
        const { selectAuthoritativePlatformManifest } = await import('./platform-management.ts');
        const selected = selectAuthoritativePlatformManifest(existing, authoritative);
        authoritativeProvisionIntents = true;
        if (!args.plan && JSON.stringify(selected) !== JSON.stringify(existing)) {
          writeInstallationManifest(selected);
        }
        existing = selected;
        if (selectedInstall && !isPlatformInstallInProgress(existing)) {
          throw new Error(
            `platform: Installation ${existing.id} is no longer unfinished. Run \`void platform status ${existing.id}\` to inspect it.`,
          );
        }
      }
    }
    const savedHyperdrive = readPlatformHyperdriveSelection(checkpoint);
    const requestedHyperdriveId = args.hyperdrive || savedHyperdrive?.id;
    const recordedHyperdrive = existing?.resources.find(
      (resource) => resource.key === 'hyperdrive',
    );
    if (
      (savedHyperdrive && requestedHyperdriveId !== savedHyperdrive.id) ||
      (recordedHyperdrive &&
        requestedHyperdriveId &&
        (requestedHyperdriveId === 'create'
          ? recordedHyperdrive.ownership === 'adopted'
          : recordedHyperdrive.id !== requestedHyperdriveId)) ||
      (savedHyperdrive &&
        recordedHyperdrive &&
        (recordedHyperdrive.ownership !== 'adopted' ||
          recordedHyperdrive.id !== savedHyperdrive.id))
    ) {
      throw new Error(
        'platform: The selected Hyperdrive differs from the saved installation. Resume with its original Hyperdrive.',
      );
    }
    const externalHyperdriveId = process.env.VOID_PLATFORM_HYPERDRIVE_ID?.trim() || '';
    const externalHyperdriveHost = process.env.VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST?.trim() || '';
    const externalHyperdriveUser = process.env.VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER?.trim() || '';
    if (
      [externalHyperdriveId, externalHyperdriveHost, externalHyperdriveUser].some(Boolean) &&
      ![externalHyperdriveId, externalHyperdriveHost, externalHyperdriveUser].every(Boolean)
    ) {
      throw new Error(
        'platform: VOID_PLATFORM_HYPERDRIVE_ID, VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST, and VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER must be set together.',
      );
    }
    let externalHyperdrive: PlatformExternalHyperdrive | undefined = externalHyperdriveId
      ? {
          id: externalHyperdriveId,
          host: externalHyperdriveHost,
          user: externalHyperdriveUser,
        }
      : undefined;
    if (
      requestedHyperdriveId &&
      externalHyperdrive &&
      requestedHyperdriveId !== externalHyperdrive.id
    ) {
      throw new Error('platform: --hyperdrive conflicts with VOID_PLATFORM_HYPERDRIVE_ID.');
    }
    if (
      savedHyperdrive &&
      externalHyperdrive &&
      (savedHyperdrive.host.toLowerCase() !== externalHyperdrive.host.toLowerCase() ||
        savedHyperdrive.user !== externalHyperdrive.user)
    ) {
      throw new Error('platform: The Hyperdrive origin differs from the saved installation.');
    }
    if (savedHyperdrive) {
      externalHyperdrive = recordedHyperdrive ? savedHyperdrive : undefined;
    }
    if (
      !externalHyperdrive &&
      requestedHyperdriveId !== 'create' &&
      (process.stdin.isTTY || requestedHyperdriveId) &&
      (!existing || isPlatformSetupDraft(existing) || requestedHyperdriveId) &&
      !recordedHyperdrive
    ) {
      const suggestedName =
        existing?.deployment.resources.hyperdrive ??
        createPlatformResourceNames(installationSlug).hyperdrive;
      const configurations = await client.listHyperdriveConfigs(accountId);
      const suggestedNameAvailable = !configurations.some(
        (resource) => resource.name === suggestedName,
      );
      const choice = requestedHyperdriveId
        ? 'existing'
        : await select({
            message: 'How should Void set up Hyperdrive?',
            options: [
              ...(configurations.length > 0
                ? [{ value: 'existing', label: 'Use an existing Hyperdrive' }]
                : []),
              ...(suggestedNameAvailable
                ? [{ value: 'create', label: 'Let Void create Hyperdrive', hint: 'recommended' }]
                : []),
              { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
            ],
          });
      if (isCancel(choice)) {
        throw new Error('platform: Cancelled.');
      }
      if (choice === 'setup') {
        note(
          `Create a Hyperdrive in account ${accountId} with any unused name${suggestedNameAvailable ? ` such as ${suggestedName}` : ''}. Point it at the same dedicated PostgreSQL database you will give Void, use a runtime database user, and disable SQL result caching. If your organization manages Hyperdrive, ask its administrator to create it. Then rerun this command and select it from the list.\nSetup: ${formatUrl('https://developers.cloudflare.com/hyperdrive/get-started/')}`,
          pc.bold('Set up Hyperdrive first'),
        );
        outro('No Cloudflare or local installation state was changed.');
        return;
      }
      if (choice === 'existing') {
        const selectedId =
          requestedHyperdriveId ??
          (await select({
            message: 'Which Hyperdrive should Void use?',
            options: [...configurations]
              .sort(
                (a, b) =>
                  Number(b.name === suggestedName) - Number(a.name === suggestedName) ||
                  a.name.localeCompare(b.name) ||
                  a.id.localeCompare(b.id),
              )
              .map((resource) => ({
                value: resource.id,
                label: resource.name,
                hint: resource.name === suggestedName ? `suggested · ${resource.id}` : resource.id,
              })),
          }));
        if (isCancel(selectedId)) {
          throw new Error('platform: Cancelled.');
        }
        const selected = configurations.find((resource) => resource.id === selectedId);
        if (!selected) {
          throw new Error('platform: The selected Hyperdrive is no longer available.');
        }
        const live = await client.getHyperdriveConfig(accountId, selected.id);
        if (live.id !== selected.id || live.name !== selected.name || !live.origin.user) {
          throw new Error(
            `platform: Could not verify the database user for existing Hyperdrive ${selected.name}.`,
          );
        }
        if (
          (savedHyperdrive &&
            (live.origin.host !== savedHyperdrive.host.toLowerCase() ||
              live.origin.user !== savedHyperdrive.user ||
              (savedHyperdrive.name && live.name !== savedHyperdrive.name) ||
              (savedHyperdrive.database && live.origin.database !== savedHyperdrive.database))) ||
          (existing &&
            !isPlatformSetupDraft(existing) &&
            live.name !== existing.deployment.resources.hyperdrive)
        ) {
          throw new Error(
            'platform: The Hyperdrive origin or name differs from the saved installation.',
          );
        }
        if (!requestedHyperdriveId) {
          note(
            [
              `${pc.bold('Database:')} ${live.origin.database}`,
              `${pc.bold('Host:')} ${live.origin.host}`,
              `${pc.bold('Port:')} ${live.origin.port ?? 'configured by Cloudflare Tunnel'}`,
              `${pc.bold('User:')} ${live.origin.user}`,
              `${pc.bold('SQL result caching:')} ${live.cachingDisabled ? 'disabled' : 'enabled'}`,
            ].join('\n'),
            pc.bold(`Existing Hyperdrive ${live.name}`),
          );
        }
        if (!live.cachingDisabled) {
          throw new Error(
            `platform: Disable SQL result caching on existing Hyperdrive ${live.name} before installing.`,
          );
        }
        externalHyperdrive = {
          id: live.id,
          name: live.name,
          database: live.origin.database,
          host: live.origin.host,
          user: live.origin.user,
        };
      }
    }
    const authenticationSelection = await selectInstallationAuthentication(
      args.authConfig,
      existing?.deployment.authentication,
      args,
    );
    const appAccess = await selectInstallationAppAccess(
      authenticationSelection,
      existing?.deployment,
      args.appAccess,
    );
    while (
      !existing &&
      process.stdin.isTTY &&
      !args.controlPlaneDomain &&
      appAccess &&
      appAccess !== 'public' &&
      controlPlaneDomain
        .toLowerCase()
        .replace(/\.$/, '')
        .endsWith(`.${applicationDomain.toLowerCase()}`)
    ) {
      log.info(
        'App Access covers subdomains. Use the domain apex or workers.dev for the platform API.',
      );
      controlPlaneDomain = await promptText(
        'Platform API hostname. Leave empty for workers.dev:',
        { placeholder: applicationDomain },
        true,
      );
    }
    if (appAccess && runtime.manifest.appAccessSetup !== 1) {
      throw new Error(
        'platform: This runtime does not support guided app access. Use the current packaged runtime.',
      );
    }
    const planInput = {
      appAccess,
      authentication: authenticationSelection.authentication,
      accountId,
      applicationDomain,
      controlPlaneDomain,
      ...(args.dashboardUrl !== undefined ? { dashboardUrl: args.dashboardUrl } : {}),
      dedicatedZone,
      displayName,
      ...(externalHyperdrive ? { externalHyperdrive } : {}),
      ...(process.env.VOID_EMAIL_SHARED_ZONE_ID
        ? { emailSharedZoneId: process.env.VOID_EMAIL_SHARED_ZONE_ID }
        : {}),
      ...(process.env.VOID_EMAIL_SENDER_DOMAIN
        ? { emailSenderDomain: process.env.VOID_EMAIL_SENDER_DOMAIN }
        : {}),
      installationSlug,
      zoneName,
      ...(workersDev ? { workersDev: true } : {}),
    };
    const planOptions = {
      authoritativeProvisionIntents,
      allowUnverifiedAiGateway: true,
      includeEmailGateway: runtime.manifest.artifacts.emailGateway !== undefined,
      enableSandbox: runtime.manifest.safetyProtocols.sandboxDrain >= 3,
      deploymentExecution: runtime.manifest.deploymentExecution === 1,
    };
    let plan = await createPlatformInstallPlan(client, planInput, existing, planOptions);
    const commandOptions = {
      commandName: cliCommandName(),
      accountId,
      installationSlug,
      displayName,
      applicationDomain,
      zoneName,
      controlPlaneDomain,
      ...(args.dashboardUrl !== undefined ? { dashboardUrl: args.dashboardUrl } : {}),
      dedicatedZone,
      workersDev,
      authConfig: args.authConfig,
      appAccess,
      authentication: authenticationSelection.authentication,
      hyperdrive:
        !existing || isPlatformSetupDraft(existing) || (externalHyperdrive && !recordedHyperdrive)
          ? (externalHyperdrive?.id ?? 'create')
          : undefined,
      runtime: args.runtime,
      ...(existing ? { resumeId: existing.id } : {}),
      yes: args.yes || process.stdin.isTTY !== true,
    };
    if (!existing) {
      savePlatformInstallChoices(
        platformInstallCommandArguments({
          ...commandOptions,
          runtime: args.runtime ? resolve(args.runtime) : '',
          ...(args.authConfig ? { authConfig: resolve(args.authConfig) } : {}),
          yes: false,
        }).slice(2),
        plan.account.name,
      );
    }
    note(
      formatPlatformInstallPlan(plan),
      pc.bold(args.plan ? 'Read-only installation plan' : 'Installation plan'),
    );
    note(formatPlatformRuntime(runtime), pc.bold('Platform runtime'));
    const managementAccess = process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN
      ? undefined
      : platformManagementAccessForAuthentication(authenticationSelection, accountId, checkpoint);
    const needsManagementToken = platformOperatorNeedsManagementToken(
      operatorCredential,
      plan,
      managementAccess,
    );
    if (args.plan) {
      note(
        formatPlatformSetupPlan(plan, {
          managementToken: needsManagementToken,
          managementAccess: !!managementAccess,
        }),
        pc.bold('Required Credentials'),
      );
      if (!existing) {
        log.info('Plan saved locally for your next install.');
      }
      outro('Plan complete and ready to execute.');
      console.log(
        `\n${pc.bold(existing ? 'Next step: run this command to resume' : 'Next, run this command to install the platform')}\n\n${pc.blue(
          formatPlatformInstallCommand(commandOptions),
        )}\n`,
      );
      return;
    }
    if (!process.stdin.isTTY) {
      assertPlatformOperatorCredentialCanApplyPlan(operatorCredential, plan, managementAccess);
    }
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: 'Apply this plan?', initialValue: true });
      if (isCancel(proceed) || !proceed) {
        outro('No changes made.');
        return;
      }
    }

    let managementApiToken =
      operatorCredential.source === 'oauth' ? checkpoint?.managementApiToken || '' : '';
    if (needsManagementToken || managementApiToken) {
      let token = managementApiToken;
      let openedManagementPage = false;
      const forgetRejectedManagementToken = () => {
        managementApiToken = '';
        if (existing && checkpoint?.managementApiToken) {
          delete checkpoint.managementApiToken;
          writePendingInstallationSecrets(existing, checkpoint);
        }
        token = '';
      };
      while (true) {
        if (!token) {
          if (!openedManagementPage) {
            openPlatformSetupPage(
              platformManagementSetupPage(plan, { access: managementAccess ?? false }),
            );
            openedManagementPage = true;
          }
          token = (
            await promptSecret('Paste management API token:', true, (value) =>
              value.trim() ? undefined : 'A value is required.',
            )
          ).trim();
        }
        const management = new PlatformCloudflareClient(token, { apiBase: client.apiBaseUrl });
        try {
          const authorizedAccounts = await management.listAccounts();
          if (!authorizedAccounts.some((account) => account.id === accountId)) {
            forgetRejectedManagementToken();
            log.warn(
              `This token cannot access ${plan.account.name}. Check its account scope and try again.`,
            );
            continue;
          }
          const verified = await createPlatformInstallPlan(
            management,
            planInput,
            existing,
            planOptions,
          );
          assertPlatformInstallPlanUnchanged(plan, verified, 'management API token');
          if (managementAccess) {
            await verifyPlatformManagementAccess(management, accountId, managementAccess);
          }
          client = management;
          plan = verified;
          managementApiToken = token;
          break;
        } catch (error) {
          if (!isPlatformTokenAuthorizationError(error)) {
            throw error;
          }
          const details = new Set<string>();
          for (
            let cause = error, depth = 0;
            depth < 5 && cause instanceof Error;
            depth++, cause = cause.cause
          ) {
            details.add(cause.message.replaceAll(token, '[redacted]'));
          }
          forgetRejectedManagementToken();
          log.warn(
            [
              ...details,
              'Check the token permissions and account/zone scope, then paste a replacement.',
            ].join('\n'),
          );
        }
      }
    } else if (managementAccess) {
      await verifyPlatformManagementAccess(client, accountId, managementAccess);
    }

    if (!existing) {
      existing = savePlatformSetupDraft(plan, runtime.manifest.platformVersion);
    }
    removeSavedPlatformInstallPlan({ ...args, account: accountId, name: installationSlug });
    const setupManifest = existing;
    const credentialSetup = isPlatformSetupDraft(existing);
    const values: Record<string, string> = { ...checkpoint };
    if (managementAccess) {
      // A verified management token replaces an older, separately collected Access token.
      delete values.accessManagementToken;
    }
    if (managementApiToken) {
      values.managementApiToken = managementApiToken;
    }
    if (externalHyperdrive) {
      values.externalHyperdriveJson = JSON.stringify(externalHyperdrive);
    }
    if (managementApiToken || externalHyperdrive || managementAccess) {
      writePendingInstallationSecrets(setupManifest, values);
    }
    const saveValues = (updates: Record<string, string>) => {
      Object.assign(values, updates);
      if (credentialSetup) {
        writePendingInstallationSecrets(setupManifest, values);
      }
    };
    const configured = (key: string, environment: string) =>
      credentialSetup
        ? process.env[environment] || values[key] || ''
        : values[key] || process.env[environment] || '';
    const collect = async (
      key: string,
      environment: string,
      message: string,
      masked = true,
      persist = true,
      validate?: (value: string) => string | undefined,
    ) => {
      let value = configured(key, environment);
      if (!value) {
        const help = platformSetupFieldHelp(key);
        if (help && process.stdin.isTTY) {
          log.info(help.description);
        }
        value = await promptSecret(message, masked, validate, help?.placeholder);
      }
      const error = validate?.(value);
      if (error) {
        throw new Error('platform: ' + error);
      }
      if (persist) {
        saveValues({ [key]: value });
      }
      return value;
    };
    const pages = platformSetupPages(plan);
    if (!configured('cloudflareApiToken', 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN')) {
      openPlatformSetupPage(pages.runtime);
    }

    const usingSavedRuntimeToken =
      credentialSetup &&
      !process.env.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN &&
      Boolean(values.cloudflareApiToken);
    let runtimeCloudflareApiToken = await collect(
      'cloudflareApiToken',
      'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN',
      'Paste runtime API token:',
      true,
      false,
    );
    let rejectedSavedRuntimeToken = false;
    const verifyRuntimeToken = async (token: string) => {
      let checkingRuntimePermissions = true;
      try {
        await verifyPlatformRuntimeTokenPermissions(new PlatformCloudflareClient(token), {
          accountId,
          applicationDomain,
          customDomains: plan.deployment.capabilities.customDomains,
          ...(plan.deployment.capabilities.email && plan.deployment.emailSharedZoneId
            ? { emailZoneId: plan.deployment.emailSharedZoneId }
            : {}),
          zoneId: plan.zone?.id ?? null,
        });
        checkingRuntimePermissions = false;
        if (plan.actions.some((action) => action.action === 'inspect')) {
          client = client.withAiGatewayToken(token);
          plan = await verifyPlatformAiGatewayPlan(
            client,
            planInput,
            existing,
            plan,
            authoritativeProvisionIntents,
          );
        }
      } catch (error) {
        if (
          credentialSetup &&
          token === values.cloudflareApiToken &&
          // The operator adds a missing email permission to the same token.
          !(error instanceof PlatformRuntimeTokenEmailPermissionError) &&
          isPlatformTokenAuthorizationError(
            error,
            checkingRuntimePermissions ? undefined : '/ai-gateway/',
          )
        ) {
          delete values.cloudflareApiToken;
          writePendingInstallationSecrets(setupManifest, values);
          rejectedSavedRuntimeToken = true;
        }
        throw error;
      }
    };
    try {
      await verifyRuntimeToken(runtimeCloudflareApiToken);
    } catch (error) {
      if (!usingSavedRuntimeToken || !process.stdin.isTTY || !rejectedSavedRuntimeToken) {
        throw error;
      }
      log.warn(
        'Cloudflare rejected the saved runtime token. Create a replacement to continue setup.',
      );
      openPlatformSetupPage(pages.runtime);
      runtimeCloudflareApiToken = await collect(
        'cloudflareApiToken',
        'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN',
        'Paste runtime API token:',
        true,
        false,
      );
      await verifyRuntimeToken(runtimeCloudflareApiToken);
    }
    saveValues({ cloudflareApiToken: runtimeCloudflareApiToken });
    const deferAuthentication =
      !!authenticationSelection.authentication.accessProtection ||
      authenticationSelection.authentication.providers.includes('cloudflare-access');
    const saveAuthenticationValues = (updates: Record<string, string>) => {
      Object.assign(values, updates);
      const latest = readPendingInstallationSecrets(setupManifest) ?? {};
      writePendingInstallationSecrets(setupManifest, { ...latest, ...updates });
    };
    const authenticationSecrets = deferAuthentication
      ? {
          authSetupToken: values.authSetupToken || randomBytes(32).toString('hex'),
          authBootstrapCode: values.authBootstrapCode || randomBytes(32).toString('hex'),
        }
      : await collectInstallationAuthentication(
          authenticationSelection,
          plan,
          values,
          saveAuthenticationValues,
        );
    if (authenticationSecrets) {
      saveAuthenticationValues(authenticationSecrets);
    }
    let bootstrapGitHubLogin = '';
    let bootstrapGitHubId = '';
    let githubClientId = '';
    let githubClientSecret = '';
    if (!authenticationSecrets) {
      const previousLogin = values.bootstrapGitHubLogin;
      bootstrapGitHubLogin = await collect(
        'bootstrapGitHubLogin',
        'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
        'Initial administrator GitHub username:',
        false,
      );
      bootstrapGitHubId =
        (previousLogin === bootstrapGitHubLogin ? values.bootstrapGitHubId : '') ||
        process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
        (await resolveBootstrapGitHubId(bootstrapGitHubLogin));
      saveValues({ bootstrapGitHubId });
    }
    const installationDatabaseUrl =
      databaseUrl ||
      (await collect('databaseUrl', 'VOID_PLATFORM_DATABASE_URL', 'PostgreSQL DATABASE_URL:'));
    saveValues({ databaseUrl: installationDatabaseUrl });
    if (!authenticationSecrets) {
      if (
        !configured('githubClientId', 'VOID_PLATFORM_GITHUB_CLIENT_ID') ||
        !configured('githubClientSecret', 'VOID_PLATFORM_GITHUB_CLIENT_SECRET')
      ) {
        openPlatformSetupPage(
          configured('githubClientId', 'VOID_PLATFORM_GITHUB_CLIENT_ID')
            ? { ...pages.github, url: 'https://github.com/settings/developers' }
            : pages.github,
        );
      }
      githubClientId = await collect(
        'githubClientId',
        'VOID_PLATFORM_GITHUB_CLIENT_ID',
        'GitHub OAuth client ID:',
        false,
        false,
      );
      githubClientSecret = await collect(
        'githubClientSecret',
        'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
        'GitHub OAuth client secret:',
        true,
        false,
      );
      saveValues({ githubClientId, githubClientSecret });
    }
    if (
      !configured('r2AccessKeyId', 'VOID_PLATFORM_R2_ACCESS_KEY_ID') ||
      !configured('r2SecretAccessKey', 'VOID_PLATFORM_R2_SECRET_ACCESS_KEY')
    ) {
      openPlatformSetupPage(pages.r2);
    }
    const r2AccessKeyId = await collect(
      'r2AccessKeyId',
      'VOID_PLATFORM_R2_ACCESS_KEY_ID',
      'Access Key ID:',
      false,
      false,
    );
    const r2SecretAccessKey = await collect(
      'r2SecretAccessKey',
      'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
      'Secret Access Key:',
      true,
      false,
    );
    saveValues({ r2AccessKeyId, r2SecretAccessKey });
    const hasFullProjectSecretKeyring = Boolean(
      checkpoint?.projectSecretKeysJson ||
      checkpoint?.projectSecretActiveKeyVersion ||
      process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON ||
      process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION,
    );
    // Interactive fresh installs keep the identity keys in this machine's encrypted
    // recovery data, like the email signing key. Headless runners may lose that data,
    // so they still supply both keys.
    const generateIdentityKeys = credentialSetup && !!process.stdin.isTTY;
    const generatedKeys = generateIdentityKeys
      ? [
          configured('jwtSecret', 'VOID_PLATFORM_JWT_SECRET') ? '' : 'JWT signing key',
          configured('projectSecretKey', 'VOID_PLATFORM_PROJECT_SECRET_KEY') ||
          hasFullProjectSecretKeyring
            ? ''
            : 'project encryption key',
        ].filter(Boolean)
      : [];
    const secrets = createPlatformInstallationSecrets({
      configurableAuthentication: !!authenticationSelection.authentication.configurable,
      ...authenticationSecrets,
      bootstrapGitHubId,
      bootstrapGitHubLogin,
      cloudflareApiToken: runtimeCloudflareApiToken,
      checkpoint: values,
      databaseUrl: installationDatabaseUrl,
      emailEnabled: plan.deployment.capabilities.email,
      emailSigningSecret: process.env.VOID_PLATFORM_EMAIL_SIGNING_SECRET || '',
      existingEmailEnabled: existing.deployment.capabilities.email,
      githubClientId,
      githubClientSecret,
      r2AccessKeyId,
      r2SecretAccessKey,
      existingInstallation: !credentialSetup,
      generateIdentityKeys,
      jwtSecret: generateIdentityKeys
        ? configured('jwtSecret', 'VOID_PLATFORM_JWT_SECRET')
        : await collect(
            'jwtSecret',
            'VOID_PLATFORM_JWT_SECRET',
            'JWT signing key:',
            true,
            true,
            credentialSetup
              ? (value) =>
                  Buffer.byteLength(value, 'utf8') >= 32
                    ? undefined
                    : 'The JWT signing secret must contain at least 32 random bytes.'
              : undefined,
          ),
      projectSecretKey:
        configured('projectSecretKey', 'VOID_PLATFORM_PROJECT_SECRET_KEY') ||
        (hasFullProjectSecretKeyring || generateIdentityKeys
          ? ''
          : await collect(
              'projectSecretKey',
              'VOID_PLATFORM_PROJECT_SECRET_KEY',
              'Project encryption key:',
              true,
              true,
              credentialSetup
                ? (value) => {
                    const key = Buffer.from(value, 'base64');
                    return key.length === 32 && key.toString('base64') === value
                      ? undefined
                      : 'The project encryption key must be canonical base64 encoding of exactly 32 bytes.';
                  }
                : undefined,
            )),
      projectSecretKeysJson: process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON || '',
      projectSecretActiveKeyVersion:
        process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION || '',
    });
    if (generatedKeys.length) {
      log.info(
        `Void generated the ${generatedKeys.join(' and ')} and keeps ${generatedKeys.length > 1 ? 'them' : 'it'} in this machine’s encrypted recovery data. ` +
          platformSetupLink({
            title: 'About these keys',
            url: 'https://void.cloud/guide/platform/installation/credentials#signing-and-encryption-keys',
          }),
      );
    }
    // A resumed install uploads the Workers it created before. Without a
    // terminal, the Cloudflare CLI stops that upload after a change outside Void,
    // and the install refuses an active version without Void's record of its
    // triggers. The installer takes the database lock later, so this check
    // cannot read the database.
    const outsideChanges = await reviewPlatformWorkerOutsideChanges({
      client,
      plan,
      runtime,
      installation: { manifest: existing },
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true && !args.yes,
      command: `${cliCommandName()} platform install --resume --name ${existing.id}`,
    });
    progress = startProgress('Installing the platform');
    if (credentialSetup) {
      // Stop treating this as an untouched local draft before any database claim is attempted.
      saveValues({
        jwtSecret: secrets.jwtSecret,
        projectSecretKey: secrets.projectSecretKey,
        ...(secrets.emailEnabled ? { emailSigningSecret: secrets.emailSigningSecret } : {}),
      });
      existing = completePlatformSetupDraft(existing);
    }
    usingUnboundDatabase = !isPlatformInstallDatabaseBound(checkpoint, existing);
    const result = await installPlatform(plan, secrets, existing, {
      acquireDatabaseLifecycleLock: acquirePlatformDatabaseLifecycleLock,
      claimDatabase: async (...claim) => {
        await claimPlatformDatabase(...claim);
        usingUnboundDatabase = false;
      },
      client,
      operatorApiToken: managementApiToken || operatorCredential.token,
      ...(outsideChanges.length > 0
        ? {
            replaceOutsideChanges: outsideChanges.map((change) => change.name),
            uploadOutsideChanges: (configs: ReadonlyArray<Record<string, unknown>>) =>
              uploadPlatformWorkerOutsideChanges(configs, {
                changes: outsideChanges,
                client,
                operatorApiToken: managementApiToken || operatorCredential.token,
                progress,
              }),
          }
        : {}),
      runtime,
      healthCheckResumeCommand: `${cliCommandName()} platform install --resume --name ${existing.id}`,
      onProgress: (message) => progress?.message(message),
      ...(deferAuthentication
        ? {
            prepareAuthentication: async (manifest: PlatformInstallationManifest) => {
              progress?.stop('Preparing Cloudflare Access configuration.');
              progress = undefined;
              const result = await collectInstallationAuthentication(
                authenticationSelection,
                plan,
                values,
                saveAuthenticationValues,
                { client, ownershipNonce: manifest.ownershipNonce, yes: args.yes },
              );
              progress = startProgress('Continuing platform installation');
              return {
                ...result,
                accessProvisioningJson: values.accessProvisioningJson,
                accessCredentialsJson: values.accessCredentialsJson,
              };
            },
          }
        : {}),
      ...(appAccess
        ? {
            prepareAppAccess: async () => {
              progress?.stop('Preparing deployed-app access.');
              progress = undefined;
              const setupJson = await prepareInstallationAppAccess({
                plan,
                authentication: authenticationSelection,
                client,
                managementToken:
                  values.managementApiToken ||
                  (operatorCredential.source !== 'oauth' ? operatorCredential.token : undefined),
                checkpoint: values,
                save: saveAuthenticationValues,
              });
              progress = startProgress('Continuing platform installation');
              return setupJson;
            },
          }
        : {}),
      replanWorkers: async (manifest) =>
        (
          await createPlatformInstallPlan(client, planInput, manifest, {
            authoritativeProvisionIntents: true,
            repairMissing: true,
            includeEmailGateway: runtime.manifest.artifacts.emailGateway !== undefined,
            enableSandbox: runtime.manifest.safetyProtocols.sandboxDrain >= 3,
            deploymentExecution: runtime.manifest.deploymentExecution === 1,
          })
        ).actions.filter((action) => action.kind === 'worker'),
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action),
      verifyExistingOwnership: async (manifest, databaseCheckpointExists) => {
        const { verifyPlatformInstallationOwnership } = await import('./platform-management.ts');
        const retainedReplacementKeys = new Set(
          plan.actions
            .filter((action) => {
              const previous = manifest.resources.find((resource) => resource.key === action.key);
              return action.action === 'create' && previous && previous.name !== action.name;
            })
            .map((action) => action.key),
        );
        await verifyPlatformInstallationOwnership(client, manifest, {
          allowUninitializedRoutingCheckpoint: databaseCheckpointExists,
          databaseUrl: secrets.databaseUrl,
          retainedReplacementKeys,
        });
      },
    });
    progress?.stop(
      result.waitingForDns || result.waitingForSandboxDrain
        ? 'Installation paused. Progress is saved.'
        : 'Platform installed.',
    );
    progress = undefined;
    if (result.waitingForDns) {
      note(
        result.zoneNameServers.length > 0
          ? `Update the domain at your registrar to use:\n${result.zoneNameServers.join('\n')}\n\nThen rerun: void platform install --resume --name ${result.manifest.id}`
          : `Wait for ${zoneName} to become active, then rerun:\nvoid platform install --resume --name ${result.manifest.id}`,
        pc.bold('Waiting for nameservers'),
      );
      outro(`Installation ${result.manifest.id} is safely checkpointed.`);
      return;
    }
    if (result.waitingForSandboxDrain) {
      note(
        "The compatible candidate runtime is live in sandbox-drain maintenance mode and application traffic remains disabled. Preview bounded work with `void platform system sandbox-drain --plan`. Follow any returned `nextCursor` with `--cursor '<value>'`. Then apply with `void platform system sandbox-drain --yes` and rerun until it reports DB-backed `complete: true`. Rerun this install command afterward to enable traffic.",
        pc.bold('Waiting for managed Sandbox drain'),
      );
      outro(`Installation ${result.manifest.id} is safely checkpointed.`);
      return;
    }
    log.info(`API URL: ${formatUrl(plan.apiUrl)}`);
    if (result.emailOperationId) {
      log.info(`Shared email routing ready. Operation: ${result.emailOperationId}.`);
    }
    const completedAuthCode = readInstallationRecoverySecrets(result.manifest)?.authBootstrapCode;
    if (result.setupPending && completedAuthCode) {
      log.info(`First administrator setup: ${formatUrl(`${plan.apiUrl}/setup`)}`);
      console.log(`One-time administrator setup code: ${completedAuthCode}`);
      log.info(`Login callback URL: ${formatUrl(`${plan.apiUrl}/auth/callback`)}`);
      log.info(
        'Confirm your identity in the browser, then test and enable any additional login methods in Settings.',
      );
      log.info(
        `If sign-in fails, run \`void platform repair ${result.manifest.id}\` to change the login settings.`,
      );
    }
    if (!plan.deployment.application.zoneName) {
      log.info(
        'Apps will use workers.dev addresses. When your domain is ready: void platform domain set <domain>',
      );
    }
    log.info('Run `void account login`, then deploy an app with `void deploy --platform void`.');
    printSuccess(
      `${result.manifest.deployment.displayName} is installed at ${new URL('/admin', plan.apiUrl).href}.`,
    );
  } catch (error) {
    progress?.error('Platform installation failed.');
    progress = undefined;
    if (existing && !args.plan && !(error instanceof PlatformAccessBlockedError)) {
      log.info(
        `Continue with: ${cliCommandName()} platform install --resume --name ${existing.id}`,
      );
      if (usingUnboundDatabase) {
        log.info(
          'To use another PostgreSQL database, set VOID_PLATFORM_DATABASE_URL to its URL first.',
        );
      }
    }
    throw error;
  } finally {
    try {
      progress?.clear();
    } finally {
      release?.();
    }
  }
}

function isPlatformTokenAuthorizationError(error: unknown, requestPathIncludes?: string): boolean {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
    if (
      error instanceof PlatformCloudflareApiError &&
      [401, 403].includes(error.status) &&
      (!requestPathIncludes || error.requestPath?.includes(requestPathIncludes))
    ) {
      return true;
    }
  }
  return false;
}

function formatPlatformRuntime(runtime: ReturnType<typeof loadPlatformRuntime>): string {
  return [
    `${pc.bold('Version:')} ${runtime.manifest.platformVersion}`,
    `${pc.bold('Source:')} ${runtime.source}`,
    `${pc.bold('Revision:')} ${runtime.manifest.sourceRevision ?? 'not recorded'}`,
    `${pc.bold('Manifest SHA-256:')} ${runtime.manifestSha256}`,
  ].join('\n');
}

export async function verifyPlatformAiGatewayPlan(
  client: Parameters<typeof createPlatformInstallPlan>[0],
  input: Parameters<typeof createPlatformInstallPlan>[1],
  existing: PlatformInstallationManifest | null,
  preview: Awaited<ReturnType<typeof createPlatformInstallPlan>>,
  authoritativeProvisionIntents: boolean,
): Promise<Awaited<ReturnType<typeof createPlatformInstallPlan>>> {
  let verified: Awaited<ReturnType<typeof createPlatformInstallPlan>>;
  try {
    verified = await createPlatformInstallPlan(client, input, existing, {
      authoritativeProvisionIntents,
      includeEmailGateway: preview.actions.some((entry) => entry.key === 'email-gateway-worker'),
      enableSandbox: preview.deployment.capabilities.sandbox,
      deploymentExecution: preview.actions.some((entry) => entry.key === 'deployment-queue'),
    });
  } catch (error) {
    if (isPlatformTokenAuthorizationError(error, '/ai-gateway/')) {
      throw new Error(
        'platform: The runtime token could not verify AI Gateway access. Include Account → AI Gateway → Edit for this account, then retry. No platform resources were created.',
        { cause: error },
      );
    }
    throw error;
  }
  assertPlatformInstallPlanUnchanged(preview, verified, 'AI Gateway access');
  return verified;
}

function assertPlatformInstallPlanUnchanged(
  preview: Awaited<ReturnType<typeof createPlatformInstallPlan>>,
  verified: Awaited<ReturnType<typeof createPlatformInstallPlan>>,
  check: string,
): void {
  const infrastructure = (plan: typeof preview) =>
    plan.actions
      .filter((action) => action.kind !== 'ai-gateway')
      .map(({ action, id, key, kind, name }) => ({ action, id, key, kind, name }));
  if (
    verified.installationId !== preview.installationId ||
    JSON.stringify(verified.deployment) !== JSON.stringify(preview.deployment) ||
    JSON.stringify(infrastructure(verified)) !== JSON.stringify(infrastructure(preview))
  ) {
    throw new Error(
      `platform: Resources changed while checking ${check}. Rerun the command to review the updated plan. No platform resources were created.`,
    );
  }
}

export function assertNoninteractivePlatformMutationAcknowledged(
  args: PlatformArgs,
  interactive: boolean,
): void {
  if (
    args.subcommand === 'list' ||
    args.subcommand === 'use' ||
    args.subcommand === 'status' ||
    args.subcommand === 'discover' ||
    args.plan ||
    interactive ||
    args.yes
  ) {
    return;
  }
  throw new Error(
    `platform: Non-interactive \`void platform ${args.subcommand}\` requires --yes to acknowledge Cloudflare changes. Run with --plan first to inspect them.`,
  );
}

async function readAccounts(
  client: PlatformCloudflareClient,
): Promise<ReadonlyArray<CloudflareAccount>> {
  // Listing authorized accounts works for browser OAuth and both account- and
  // user-scoped API tokens. /user/tokens/verify only understands the latter.
  const accounts = await client.listAccounts();
  if (accounts.length === 0) {
    throw new Error('platform: This Cloudflare token has no accessible accounts.');
  }
  return accounts;
}

async function selectAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): Promise<string> {
  if (selector) {
    const matches = accounts.filter(
      (account) => account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
    );
    if (matches.length === 0) {
      throw new Error(
        `platform: Cloudflare account ${JSON.stringify(selector)} is unavailable through the current access token. Run ${pc.blue('void cloudflare status')} to see which accounts have access, and re-authenticate if necessary.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `platform: Cloudflare account ${JSON.stringify(selector)} is ambiguous. Use --account <id> to select a specific account.`,
      );
    }
    return matches[0]!.id;
  }
  if (accounts.length === 1) {
    return accounts[0]!.id;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'platform: --account <id> is required when the token can access multiple accounts.',
    );
  }
  const value = await select({
    message: 'Cloudflare account:',
    options: accounts.map((account) => ({
      label: account.name,
      value: account.id,
      hint: account.id,
    })),
  });
  if (isCancel(value)) {
    throw new Error('platform: Cancelled.');
  }
  return String(value);
}

async function promptText(
  message: string,
  value: string | { placeholder: string },
  optional = false,
  validate?: (input: string) => string | undefined,
): Promise<string> {
  if (!process.stdin.isTTY) {
    if (optional) {
      return '';
    }
    throw new Error(`platform: ${message.replace(/:$/, '')} is required in non-interactive mode.`);
  }
  const defaultValue = typeof value === 'string' ? value : undefined;
  const input = await text({
    message,
    ...(typeof value === 'string' ? { placeholder: value, defaultValue } : value),
    validate: (input) => {
      const candidate = input || defaultValue;
      return candidate ? validate?.(candidate) : optional ? undefined : 'A value is required.';
    },
  });
  if (isCancel(input) || typeof input === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return input;
}

async function promptSecret(
  message: string,
  masked = true,
  validate?: (value: string) => string | undefined,
  placeholder?: string,
): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `platform: ${message.replace(/:$/, '')} is required in non-interactive mode. Set the documented VOID_PLATFORM_* environment variable.`,
    );
  }
  const options = {
    message,
    validate: (input: string | undefined) => (input ? validate?.(input) : 'A value is required.'),
  };
  const value = masked
    ? await password({ ...options, placeholder })
    : await text({ ...options, placeholder });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}
