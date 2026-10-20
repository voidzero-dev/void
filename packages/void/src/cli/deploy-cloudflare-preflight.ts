import { existsSync } from 'node:fs';
import { isDeepStrictEqual as deepEqual } from 'node:util';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  readWranglerTopLevelString,
  assertExistingCloudflareConfig,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { basename, dirname, relative } from 'pathslash';
import { analyzeApplicationSync, type ApplicationAnalysis } from '../application-analysis.ts';
import { MATERIALIZED_CLOUDFLARE_FILE } from '../cloudflare-config.ts';
import { resolveBindingNames, type VoidConfig } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import { assertSandboxNamespaceConfig, resolveSandboxConfig } from '../sandbox/config.ts';
import { classifyCloudflareDeployApp } from './cloudflare-deploy/classify.ts';
import { approvedCloudflareIsrBinding, chooseCloudflareIsr } from './cloudflare-isr.ts';
import { readCloudflareLink, type CloudflareLink } from './cloudflare-link.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import { resolveEnvSchemaFactsDefault } from './deploy-artifact-validation.ts';
import {
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
  reconstructExpectedContainers,
  reconstructExpectedDurableObjectState,
} from './deploy-binding-snapshot.ts';
import {
  isWranglerNonInteractiveOrCI,
  prepareExistingCloudflareDeployWithAuth,
} from './deploy-cloudflare-auth.ts';
import { hasVoidSendEmailBinding, runCloudflareEmailStep } from './deploy-cloudflare-email.ts';
import {
  confirmCloudflareDeployAuthentication,
  connectCloudflareDeployAccount,
  discoverRootWranglerConfig,
} from './deploy-cloudflare-helpers.ts';
import { log } from './deploy-helpers.ts';
import {
  resolveWranglerMigrationPattern,
  formatCloudflareDriftMessage,
} from './deploy-migrations.ts';
import {
  computeDesiredCloudflareResources,
  deriveWorkerName,
  formatCloudflareSandboxUnavailable,
  CLOUDFLARE_RESOURCE_LABELS,
} from './deploy-resources.ts';
import { printDeployContext } from './deploy-summary.ts';
import { buildSchemaProbeEnv } from './deploy-transport.ts';
import {
  type RunDeployOptions,
  type CloudflareDeployDeps,
  type EmailAddressMapInput,
} from './deploy-types.ts';
import { createNodeEmailDns, SEND_EMAIL_BINDING } from './email-cloudflare.ts';
import type { EnvSchemaProbeResult } from './env-schema-probe.ts';
import { selfHostSchemaFailureMessage, type SelfHostSchemaFacts } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
import { getErrorMessage } from './output.ts';
import {
  assertValidResourceName,
  checkCloudflareProvisionDrift,
  isQueueConfirmedAbsent,
  provisionCloudflareResources,
  type ProvisionDriftEntry,
} from './provision.ts';
import { sameMigrationsDir, writeProvisionedWranglerConfig } from './wrangler.ts';

/** Validate source-level native deploy inputs before account operations or project code. */
export async function prepareCloudflareDeploySource(
  root: string,
  options: RunDeployOptions,
  voidConfig: VoidConfig,
): Promise<
  ({ configPath: string } & Awaited<ReturnType<typeof computeDesiredCloudflareResources>>) | null
> {
  // Every gate on this path validates the artifact the build emits, so a skipped build would
  // check a stale or missing one.
  if (options.skipBuild) {
    log.error(
      [
        'deploy: --skip-build is not supported with --platform cloudflare.',
        'This backend validates the artifact the build emits — the worker vars in',
        'dist/ssr/wrangler.json and the generated auth schema — so a skipped build would',
        'leave every check reading a stale or missing artifact instead of the worker you',
        'are about to upload. Drop --skip-build, or deploy with `void deploy` (the managed',
        'platform), which supports it.',
      ].join('\n'),
    );
    return null;
  }

  // Reject app shapes the native verifier cannot prove safe before any account operation.
  let application: ApplicationAnalysis;
  try {
    application = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  } catch (error) {
    log.error(`deploy: ${getErrorMessage(error)}`);
    return null;
  }
  const classification = classifyCloudflareDeployApp(root, voidConfig, options, application);
  if (!classification.supported) {
    log.error(classification.reason);
    return null;
  }

  // The migration gates re-collect migrations after the build, because build plugins can
  // rewrite them; these pre-build ones only fail fast.
  const configPath = discoverRootWranglerConfig(root);
  const facts = await computeDesiredCloudflareResources(root, voidConfig, configPath, application);
  const { desired, dialect, migrations: preBuildMigrations, migrationsDir } = facts;

  if (dialect !== 'sqlite' && preBuildMigrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      [
        `deploy: ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations require DATABASE_URL for --platform cloudflare.`,
        'Set the production connection string in the deploy environment. Void uses it only to',
        'provision Hyperdrive and apply checked-in migrations before uploading the Worker; it is',
        'never written to wrangler.jsonc or the generated Worker config.',
      ].join('\n'),
    );
    return null;
  }

  // Void generates and applies migrations from one folder only, and the provisioner never
  // rewrites a set migrations_dir. Any spelling of that folder matches; another folder stops
  // the deploy here. A handoff applies no migrations, so it is kept.
  const storedDir =
    desired.d1 &&
    readStoredResourceName(
      parseRootWranglerConfig(configPath),
      'd1_databases',
      desired.d1.binding,
      'migrations_dir',
    );
  if (
    !(options.reuseExistingWorker || readCloudflareLink(root)) &&
    desired.d1?.migrationsDir !== undefined &&
    storedDir !== undefined &&
    !sameMigrationsDir(configPath, storedDir, desired.d1.migrationsDir)
  ) {
    const expected = JSON.stringify(desired.d1.migrationsDir);
    let fix = `Set migrations_dir to ${expected} in d1_databases of ${basename(configPath)}, or remove it and Void will fill it in.`;
    if (basename(configPath) === MATERIALIZED_CLOUDFLARE_FILE) {
      // Removing helps only for an authored value; one Void filled in lives in void.lock.json.
      const authored = readStoredResourceName(
        voidConfig.cloudflare ?? {},
        'd1_databases',
        desired.d1.binding,
        'migrations_dir',
      );
      fix = `Set migrations_dir to ${expected} in cloudflare.d1_databases of void.config.ts${authored === undefined ? '.' : ', or remove it and Void will fill it in.'}`;
    }
    log.error(
      `deploy: D1 binding ${JSON.stringify(desired.d1.binding)} sets migrations_dir ${JSON.stringify(storedDir)}, but Void generates and applies migrations from ${expected}. ${fix}`,
    );
    return null;
  }

  // Custom migration patterns must stay under migrations_dir.
  if (desired.d1) {
    const migrationsPattern = resolveWranglerMigrationPattern(
      parseRootWranglerConfig(configPath),
      desired.d1.binding,
      desired.d1.migrationsDir ?? relative(dirname(configPath), migrationsDir),
    );
    if (!migrationsPattern.ok) {
      log.error(migrationsPattern.reason);
      return null;
    }
  }

  return { configPath, ...facts };
}

export type CloudflareDeploySource = NonNullable<
  Awaited<ReturnType<typeof prepareCloudflareDeploySource>>
>;

export type CloudflarePreflight = Awaited<ReturnType<typeof preflightCloudflareWorker>>;

/** Pin the account and uploader, set up email, provision resources and snapshot the pins. */
export async function preflightCloudflareWorker(input: {
  readonly root: string;
  readonly voidConfig: VoidConfig;
  readonly options: RunDeployOptions;
  readonly deps: CloudflareDeployDeps;
  readonly exit: (code: number) => never;
  readonly cliLog: CliLogger;
  readonly initialCloudflareLink: CloudflareLink | null;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
  readonly source: CloudflareDeploySource;
}): Promise<{
  apiBaseUrl: string;
  usesCf: boolean;
  cfUploaderIsPinned: () => boolean;
  assertUploaderStillPinned: () => boolean;
  accountId: string;
  workersDevSubdomain: string | undefined;
  runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  workerName: string;
  emailMap: EmailAddressMapInput | null;
  schemaFacts: SelfHostSchemaFacts;
  existingWorker: ExistingCloudflareWorker | null;
  pinnedHandoffLink: CloudflareLink | null;
  approvedHandoffKv: Array<ApprovedCloudflareKvBinding>;
  bindingIdentitySnapshot: ReturnType<typeof snapshotBindingIdentities>;
  passthroughIdentitySnapshot: ReturnType<typeof snapshotPassthroughIdentities>;
  passthroughRawFields: ReturnType<typeof snapshotPassthroughRawFields>;
  expectedContainers: ReturnType<typeof reconstructExpectedContainers>;
  expectedDurableObjectState: ReturnType<typeof reconstructExpectedDurableObjectState>;
}> {
  const {
    root,
    voidConfig,
    options,
    deps,
    exit,
    cliLog,
    initialCloudflareLink,
    detectedFramework,
    source,
  } = input;
  const {
    configPath,
    needsSandbox,
    needsEmail,
    emailHandlers,
    authEnabled,
    needsAI,
    expectedCrons,
    desired,
    migrations: preBuildMigrations,
    reasons,
    needsLive,
  } = source;

  let rootConfig = parseRootWranglerConfig(configPath);
  if (needsSandbox) {
    try {
      assertSandboxNamespaceConfig(rootConfig, resolveSandboxConfig(voidConfig, root));
    } catch (error) {
      log.error(`deploy: ${getErrorMessage(error)}`);
      return exit(1);
    }
  }

  // One transport, account and uploader for every credentialed command of this deploy.
  const connection = await connectCloudflareDeployAccount({
    root,
    configPath,
    rootConfig,
    deps,
    persistAccount: !(options.reuseExistingWorker || initialCloudflareLink),
  });
  if (!connection) {
    return exit(1);
  }
  const {
    apiBaseUrl,
    usesCf,
    cfUploaderIsPinned,
    assertUploaderStillPinned,
    accountId,
    workersDevSubdomain,
    runWrangler,
  } = connection;
  rootConfig = connection.rootConfig;
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  printDeployContext(workerName, 'Cloudflare');

  // Email setup makes credentialed calls, so it runs before the env-schema probe runs any
  // project code. Its config writes become part of the baseline the probe check compares.
  let emailMap: EmailAddressMapInput | null = null;
  if (needsEmail) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const email = await runCloudflareEmailStep({
      root,
      configPath,
      voidConfig,
      rootConfig,
      handlers: emailHandlers,
      workerName,
      accountId,
      apiBaseUrl,
      runWrangler,
      nonInteractive: deps.isCI ?? isWranglerNonInteractiveOrCI(),
      confirm:
        deps.confirmEmailSetup ??
        (async (message) => {
          const answer = await confirm({ message, initialValue: true });
          return !isCancel(answer) && answer === true;
        }),
      fetchImpl: deps.emailFetch ?? fetch,
      dns: deps.emailDns ?? (await createNodeEmailDns()),
    });
    if (email.abortDeploy) {
      return exit(1);
    }
    if (options.requireEmail && !email.satisfied) {
      log.error(
        [
          'deploy: --require-email — email is not fully set up for this deploy (see above); refusing to deploy.',
          'Nothing was built or uploaded. Set email up, or drop --require-email.',
        ].join('\n'),
      );
      return exit(1);
    }
    if (email.configWritten) {
      rootConfig = parseRootWranglerConfig(configPath);
    }
    emailMap = email.map;
  } else {
    // The app stopped using email, but its routing rules still point at this Worker. Warn only:
    // removing the config would orphan the live rules, and `[]` would delete them.
    const staleAddresses = Array.isArray(rootConfig.addresses)
      ? (rootConfig.addresses as Array<unknown>).filter((a): a is string => typeof a === 'string')
      : [];
    const staleBinding = hasVoidSendEmailBinding(rootConfig);
    if (staleAddresses.length > 0 || staleBinding) {
      log.warn(
        [
          'deploy: this app no longer declares email handlers or imports void/email, but the Cloudflare config still carries the email setup Void wrote:',
          ...staleAddresses.map(
            (a) =>
              `  • ${a} — still routed to worker "${workerName}", which no longer exports email(); inbound mail there will fail.`,
          ),
          ...(staleBinding ? [`  • send_email ${SEND_EMAIL_BINDING} binding`] : []),
          'Deploying as-is. To detach: remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in void.lock.json (and any authored overrides in void.config.ts), then delete the rules in the Cloudflare dashboard (Email → Email Routing → Routing rules).',
        ].join('\n'),
      );
    }
  }

  // env.ts is project code, so read its key names in an uncredentialed subprocess. Running it
  // before provisioning makes a broken env.ts fail fast.
  const schemaProbeEnv = buildSchemaProbeEnv(accountId, apiBaseUrl);
  let schemaResult: EnvSchemaProbeResult;
  try {
    schemaResult = await (deps.resolveSchemaFacts ?? resolveEnvSchemaFactsDefault)(
      { root },
      schemaProbeEnv,
    );
  } catch (err) {
    log.error(`deploy: could not derive the env schema — ${getErrorMessage(err)}`);
    return exit(1);
  }
  if (schemaResult.kind === 'schema-error') {
    log.error(`deploy: ${selfHostSchemaFailureMessage(schemaResult.reason)}`);
    return exit(1);
  }
  const schemaFacts: SelfHostSchemaFacts = schemaResult.facts;

  // The probe can still rewrite files. Check the root config before any credentialed command,
  // and before the provisioner makes its own legitimate writes.
  if (!deepEqual(rootConfig, parseRootWranglerConfig(configPath))) {
    log.error(
      [
        'deploy: the root wrangler config changed during the pre-build env-schema probe.',
        'Refusing to run an authenticated Cloudflare command with a config rewritten by project',
        'code. Rebuild from a clean checkout, then rerun.',
      ].join('\n'),
    );
    return exit(1);
  }

  // The probe ran project code, so the uploader is re-checked before this credentialed run.
  if (!(await confirmCloudflareDeployAuthentication(connection, configPath))) {
    return exit(1);
  }

  let existingWorker: ExistingCloudflareWorker | null = null;
  let pinnedHandoffLink: CloudflareLink | null = null;
  let approvedHandoffKv: Array<ApprovedCloudflareKvBinding> = [];
  if (options.reuseExistingWorker || initialCloudflareLink) {
    if (
      authEnabled ||
      needsSandbox ||
      needsAI ||
      expectedCrons.length ||
      desired.queues.length ||
      preBuildMigrations.length
    ) {
      throw new Error(
        'Link the existing site without adding runtime features, auth setup, or database migrations. Make those changes in a later deployment.',
      );
    }
    approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
    existingWorker = await prepareExistingCloudflareDeployWithAuth(
      {
        root,
        configPath,
        accountId,
        reuse: options.reuseExistingWorker,
        pinnedLink: initialCloudflareLink,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        approvedKv: approvedHandoffKv,
      },
      assertUploaderStillPinned,
    );
    pinnedHandoffLink = readCloudflareLink(root);
    if (!pinnedHandoffLink) {
      throw new Error('The pending Cloudflare handoff was not saved before deployment.');
    }
    rootConfig = parseRootWranglerConfig(configPath);

    // Resolve the cache choice now. The saved setting applies to retries and later deploys.
    const isrNamespace = desired.kvNamespaces.find(
      (namespace) => namespace.binding === 'ISR_CACHE',
    );
    if (
      existingWorker &&
      !existingWorker.bindings.some((binding) => binding.name === 'ISR_CACHE') &&
      resolveBindingNames(voidConfig.inference?.bindings)?.kv !== 'ISR_CACHE' &&
      isrNamespace
    ) {
      const missing = checkCloudflareProvisionDrift(configPath, desired).missing.filter(
        (entry) => entry.binding !== 'ISR_CACHE',
      );
      if (missing.length) {
        throw new Error(
          formatCloudflareDriftMessage(
            missing,
            reasons,
            'Linking cannot provision these inferred resources:',
            'Keep new application resources separate from this migration.',
          ),
        );
      }
      const enabled = await chooseCloudflareIsr(root, voidConfig, {
        interactive: !(deps.isCI ?? isWranglerNonInteractiveOrCI()),
        confirm: deps.confirmIsrSetup,
      });
      if (!enabled) {
        desired.kvNamespaces = desired.kvNamespaces.filter(
          (namespace) => namespace.binding !== 'ISR_CACHE',
        );
      } else {
        if (approvedHandoffKv.length === 0) {
          if (!assertUploaderStillPinned()) {
            return exit(1);
          }
          await (deps.provision ?? provisionCloudflareResources)(
            root,
            configPath,
            {
              kvNamespaces: [isrNamespace],
              queues: [],
            },
            {
              accountId,
              log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
            },
          );
          rootConfig = parseRootWranglerConfig(configPath);
          approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
          if (approvedHandoffKv.length !== 1) {
            throw new Error(
              'ISR setup did not record a valid cache namespace. Rerun `void deploy` to retry.',
            );
          }
        }
        assertExistingCloudflareConfig(existingWorker, rootConfig, false, approvedHandoffKv);
      }
      cliLog.info('cloudflare_handoff_isr_choice', { enabled });
    }
  }

  // Sandbox needs Workers Paid. A read-only Containers probe checks the plan and token before
  // provisioning; its failure cannot tell the two apart, so the message covers both. Apps
  // without Sandbox never run it.
  if (needsSandbox) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const containers = await Promise.resolve(
      runWrangler(
        {
          type: 'containers.list',
          configPath: existsSync(configPath) ? configPath : undefined,
        },
        { capture: true },
      ),
    );
    if (!isCleanCloudflareExit(containers)) {
      log.error(formatCloudflareSandboxUnavailable({ preflight: true }));
      return exit(1);
    }
    cliLog.info('cloudflare_sandbox_available');
  }

  // Whether the root config lacks the D1 migrations_dir. A set one for another folder already
  // stopped the deploy in prepareCloudflareDeploySource.
  const d1MigrationsDirMissing = (): boolean =>
    desired.d1?.migrationsDir !== undefined &&
    readStoredResourceName(
      parseRootWranglerConfig(configPath),
      'd1_databases',
      desired.d1.binding,
      'migrations_dir',
    ) === undefined;

  // Create missing inferred resources. Missing ids trigger this directly, absent queues after
  // the probe below; `--provision` forces it. The provisioner is read-first and idempotent.
  const provisionAndVerify = async (): Promise<void> => {
    if (existingWorker) {
      const { missing } = checkCloudflareProvisionDrift(configPath, desired);
      throw new Error(
        missing.length > 0
          ? formatCloudflareDriftMessage(
              missing,
              reasons,
              'Linking cannot provision these inferred resources:',
              `Check the existing Worker's binding names and resource IDs in void.config.ts and inference.bindings there, then rerun \`void deploy\`. Keep new resources for a later deployment.`,
            )
          : 'Linking cannot provision resources. Remove --provision and rerun `void deploy` to reuse the existing Worker.',
      );
    }
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const provision = deps.provision ?? provisionCloudflareResources;
    let result;
    try {
      result = await provision(root, configPath, desired, {
        accountId,
        log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
      });
      cliLog.info('cloudflare_provisioned', {
        resources: result.resources.map((r) => `${r.kind}:${r.action}`),
      });
    } catch (err) {
      log.error(`deploy: provisioning failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
    // A skipped resource (e.g. Hyperdrive with no connection source) would ship a Worker that
    // fails on first use.
    const skipped = result.resources.filter((r) => r.action === 'skipped');
    if (skipped.length > 0) {
      log.error(
        [
          'deploy: these required resources were skipped during provisioning and are NOT available:',
          ...skipped.map((r) => {
            const label =
              CLOUDFLARE_RESOURCE_LABELS[r.kind as ProvisionDriftEntry['kind']] ?? r.kind;
            return `  • ${r.binding ?? r.name} (${label})${r.reason ? ` — ${r.reason}` : ''}`;
          }),
          'Resolve the connection source (e.g. set DATABASE_URL for Hyperdrive, or adopt an',
          'existing config), then rerun. Nothing was built or deployed — but provisioning runs',
          'before this check, so any resource listed as created above already exists in your',
          'account (rerunning adopts it rather than duplicating it).',
        ].join('\n'),
      );
      return exit(1);
    }
    const { missing } = checkCloudflareProvisionDrift(configPath, desired);
    if (missing.length > 0) {
      log.error(
        formatCloudflareDriftMessage(
          missing,
          reasons,
          'deploy: provisioning did not satisfy every required resource:',
          'Retry `void deploy --platform cloudflare`, or provision the listed resources manually.',
        ),
      );
      return exit(1);
    }
    if (desired.d1 && d1MigrationsDirMissing()) {
      log.error(
        `deploy: provisioning did not set migrations_dir for D1 binding ${desired.d1.binding}. Retry \`void deploy --platform cloudflare\`.`,
      );
      return exit(1);
    }
  };

  const { missing: initiallyMissing } = checkCloudflareProvisionDrift(configPath, desired);
  // A handoff applies no migrations, so preserve the existing local migration settings.
  // Reconciling migrations_dir must not send an already-bound database to the provisioner.
  const d1NeedsConfigReconciliation = !existingWorker && d1MigrationsDirMissing();
  if (options.provision || initiallyMissing.length > 0 || d1NeedsConfigReconciliation) {
    await provisionAndVerify();
  } else {
    // Queue names come from unsanitized file paths. Report every invalid one before probing.
    const invalidQueues = desired.queues.filter((name) => {
      try {
        assertValidResourceName('queue', name);
        return false;
      } catch {
        return true;
      }
    });
    if (invalidQueues.length > 0) {
      log.error(
        [
          'Deploy blocked — these queue names are not valid Cloudflare queue names:',
          ...invalidQueues.map((name) => `  • ${name} (queue)`),
          '',
          'A queue takes its name from its path in queues/; nested segments are joined with "-".',
          'A queue name must be 1–63 characters, contain only letters, digits and "-", and',
          'begin and end with a letter or digit.',
          '',
          'Rename the offending file(s) in queues/ and retry.',
        ].join('\n'),
      );
      return exit(1);
    }
    // Queues have no id in the config, so the drift check cannot see a missing one. Probe each
    // by name; only a confirmed not-found triggers provisioning, never an inconclusive probe.
    const absentQueues: Array<string> = [];
    for (const name of desired.queues) {
      const info = await Promise.resolve(
        runWrangler({ type: 'queues.info', name, configPath }, { capture: true }),
      );
      if (isQueueConfirmedAbsent(info)) {
        absentQueues.push(name);
      }
    }
    if (absentQueues.length > 0) {
      await provisionAndVerify();
    }
  }

  // Persist the Worker name and account before the build. The CF Vite plugin copies
  // `account_id` only from the config file, so an env-only account would otherwise leave the
  // artifact without one, and the secret gate resolves the Worker from the root `name`.
  const frameworkQueues = detectedFramework ? source.analysis.queues : [];
  writeProvisionedWranglerConfig(
    root,
    {
      name: workerName,
      accountId,
      ...(detectedFramework
        ? {
            queues: {
              producers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                binding: queue.bindingName,
              })),
              consumers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                ...(queue.maxBatchSize != null && { max_batch_size: queue.maxBatchSize }),
                ...(queue.maxBatchTimeout != null && {
                  max_batch_timeout: queue.maxBatchTimeout,
                }),
                ...(queue.maxRetries != null && { max_retries: queue.maxRetries }),
                ...(queue.retryDelay != null && { retry_delay: queue.retryDelay }),
              })),
              reconcileVoidOwned: true,
            },
          }
        : {}),
    },
    { configPath },
  );

  // Snapshot the config before the build runs project code. A build can only edit files, so
  // the remote migration and the emitted-config check compare against these pins to catch a
  // binding, container or migration it added, dropped or retargeted. Nothing legitimate
  // rewrites a binding id in the root config after this point.
  const preBuildRootConfig = parseRootWranglerConfig(configPath);
  const bindingIdentitySnapshot = snapshotBindingIdentities(preBuildRootConfig);
  const passthroughIdentitySnapshot = snapshotPassthroughIdentities(preBuildRootConfig);
  const passthroughRawFields = snapshotPassthroughRawFields(preBuildRootConfig);
  const expectedContainers = reconstructExpectedContainers(
    voidConfig,
    root,
    preBuildRootConfig,
    needsSandbox,
  );
  const expectedDurableObjectState = reconstructExpectedDurableObjectState(
    voidConfig,
    root,
    preBuildRootConfig,
    { needsSandbox, needsLive, analysis: source.analysis },
  );
  return {
    apiBaseUrl,
    usesCf,
    cfUploaderIsPinned,
    assertUploaderStillPinned,
    accountId,
    workersDevSubdomain,
    runWrangler,
    workerName,
    emailMap,
    schemaFacts,
    existingWorker,
    pinnedHandoffLink,
    approvedHandoffKv,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    expectedContainers,
    expectedDurableObjectState,
  };
}
