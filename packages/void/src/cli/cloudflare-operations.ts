import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { CloudflareCommandResult, CloudflareOperation } from '@void/deploy-cloudflare';
import {
  encodeCloudflareVersionMessage,
  deployCloudflareVersionTraffic,
  parseCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  readBindingFieldPresence,
  readWranglerTopLevelString,
  resolveD1MigrateTarget,
  type CloudflareVersionMetadata,
} from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { materializeCloudflareConfig, persistCloudflareConfig } from '../cloudflare-config.ts';
import { createCloudflareProcessRunner } from './cloudflare-process.ts';
import { findAmbientConfigOverride, findWranglerCiOverrideDotenvFile } from './deploy-transport.ts';
import { getErrorMessage } from './output.ts';
import {
  assertNoTransportRedirectInProjectDotenv,
  deleteEnvVarCaseAware,
  provisionEnv,
  resolvePinnedApiBaseUrl,
} from './provision.ts';
import {
  readWranglerCustomDomains,
  readWranglerPublishedTrafficSnapshot,
  writeWranglerPublishedTrafficSnapshot,
  updateWranglerCustomDomain,
  type WranglerCustomDomain,
} from './wrangler.ts';

export type CloudflareOperationRunner = (
  args: CloudflareOperation,
  options: { capture: boolean; input?: string },
) => CloudflareCommandResult | Promise<CloudflareCommandResult>;

export type CloudflareOperationContext = {
  accountId: string;
  apiBaseUrl: string;
  configPath: string;
  workerName: string;
  runWrangler: CloudflareOperationRunner;
};

export type CloudflareWorkerVersion = {
  id: string;
  createdAt: string | null;
  message: string | null;
  metadata: CloudflareVersionMetadata | null;
};

export type CloudflareWorkerStatus = {
  workerName: string;
  activeVersionId: string | null;
  deployedVersionIds: Array<string>;
  versions: Array<CloudflareWorkerVersion>;
};

export type CloudflareD1Context = {
  operation: CloudflareOperationContext;
  binding: string;
  migrateToken: string;
  /** Unset when the binding has no `migrations_dir`; Cloudflare then applies `./migrations`. */
  migrationsDir: string | undefined;
  migrationsTable: string;
};

export function resolveCloudflareOperationContext(
  root: string,
  runner?: CloudflareOperationRunner,
): CloudflareOperationContext {
  const configPath = materializeCloudflareConfig(root);
  if (!existsSync(configPath)) {
    throw new Error(`No Cloudflare config found at "${configPath}". Run \`void init\` first.`);
  }
  assertNoOperationConfigOverride(root);
  assertNoTransportRedirectInProjectDotenv(root);
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name');
  if (!workerName) {
    throw new Error(
      `Cloudflare config "${configPath}" has no worker name. Run \`void init\` first.`,
    );
  }
  const accountId =
    readWranglerTopLevelString(config, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    throw new Error(
      'No Cloudflare account is pinned. Set cloudflare.account_id in void.config.ts or CLOUDFLARE_ACCOUNT_ID.',
    );
  }
  const apiBaseUrl = resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(config, 'compliance_region'),
  );
  return {
    accountId,
    apiBaseUrl,
    configPath,
    workerName,
    runWrangler: runner ?? createCloudflareOperationRunner(root, accountId, apiBaseUrl),
  };
}

export async function listCloudflareSecrets(
  context: CloudflareOperationContext,
): Promise<Array<string>> {
  const result = await run(context, {
    type: 'secret.list',
    configPath: context.configPath,
    workerName: context.workerName,
  });
  const parsed = requireData(result.data, 'Cloudflare secret list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare secret list returned an unexpected response.');
  }
  return parsed
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const value = entry as Record<string, unknown>;
      return typeof value.name === 'string' ? value.name : null;
    })
    .filter((name): name is string => name !== null)
    .sort();
}

export async function putCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
  value: string,
): Promise<void> {
  await run(
    context,
    {
      type: 'secret.put',
      name: name,
      configPath: context.configPath,
      workerName: context.workerName,
    },
    { input: value },
  );
}

export async function syncCloudflareSecrets(
  context: CloudflareOperationContext,
  secrets: ReadonlyArray<{ name: string; value: string }>,
): Promise<void> {
  const values = Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
  await run(
    context,
    { type: 'secret.bulk', configPath: context.configPath, workerName: context.workerName },
    {
      input: `${JSON.stringify(values)}\n`,
    },
  );
}

export async function deleteCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
): Promise<void> {
  await run(context, {
    type: 'secret.delete',
    name: name,
    configPath: context.configPath,
    workerName: context.workerName,
  });
}

export function resolveCloudflareD1Context(
  root: string,
  binding: string,
  runner?: CloudflareOperationRunner,
): CloudflareD1Context {
  const operation = resolveCloudflareOperationContext(root, runner);
  const config = parseRootWranglerConfig(operation.configPath);
  const target = resolveD1MigrateTarget(config, binding);
  if (!target.ok) {
    throw new Error(`Cannot resolve D1 binding ${binding}: ${target.reason}.`);
  }
  const migrationsDir = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_dir');
  const migrationsTable = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_table',
  );
  if (
    migrationsDir.present &&
    (typeof migrationsDir.value !== 'string' || migrationsDir.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_dir.`);
  }
  if (
    migrationsTable.present &&
    (typeof migrationsTable.value !== 'string' || migrationsTable.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_table.`);
  }
  return {
    operation,
    binding,
    migrateToken: target.token,
    migrationsDir: migrationsDir.present ? (migrationsDir.value as string) : undefined,
    migrationsTable: migrationsTable.present ? (migrationsTable.value as string) : 'd1_migrations',
  };
}

export async function executeCloudflareD1Sql(
  context: CloudflareD1Context,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await run(context.operation, {
    type: 'd1.execute',
    database: context.migrateToken,
    sql: sql,
    configPath: context.operation.configPath,
  });
  const parsed = requireData(result.data, 'Cloudflare D1 execute');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare D1 execute returned an unexpected response.');
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Cloudflare D1 execute returned a malformed result.');
    }
    const resultRows = (item as Record<string, unknown>).results;
    if (!Array.isArray(resultRows)) {
      continue;
    }
    for (const row of resultRows) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    }
  }
  return rows;
}

export async function readCloudflareD1Migrations(
  context: CloudflareD1Context,
): Promise<Array<string>> {
  const table = context.migrationsTable.replace(/"/g, '""');
  try {
    const rows = await executeCloudflareD1Sql(context, `SELECT name FROM "${table}" ORDER BY name`);
    return rows
      .map((row) => (typeof row.name === 'string' ? row.name : null))
      .filter((name): name is string => name !== null);
  } catch (error) {
    if (/no such table/i.test(getErrorMessage(error))) {
      return [];
    }
    throw error;
  }
}

export async function applyCloudflareD1Migrations(context: CloudflareD1Context): Promise<void> {
  await run(
    context.operation,
    {
      type: 'd1.migrations.apply',
      database: context.migrateToken,
      configPath: context.operation.configPath,
    },
    { capture: false },
  );
}

/** Restore the D1 database with Time Travel. Returns the bookmark that undoes the restore. */
export async function restoreCloudflareD1Database(
  context: CloudflareD1Context,
  target: { bookmark: string } | { timestamp: string },
): Promise<string | undefined> {
  const result = await run(context.operation, {
    type: 'd1.time-travel.restore',
    database: context.migrateToken,
    target,
    configPath: context.operation.configPath,
  });
  const previous = (result.data as { previousBookmark?: unknown } | undefined)?.previousBookmark;
  return typeof previous === 'string' ? previous : undefined;
}

export async function readCloudflareWorkerStatus(
  context: CloudflareOperationContext,
): Promise<CloudflareWorkerStatus> {
  const [deployment, deployments, versions] = await Promise.all([
    run(context, {
      type: 'deployments.status',
      configPath: context.configPath,
      workerName: context.workerName,
    }),
    run(context, {
      type: 'deployments.list',
      configPath: context.configPath,
      workerName: context.workerName,
    }),
    run(context, {
      type: 'versions.list',
      configPath: context.configPath,
      workerName: context.workerName,
    }),
  ]);
  const activeVersionId = parseActiveVersionId(deployment.data);
  const deployedVersionIds = parseCloudflareDeployedVersionIds(deployments.data);
  if (activeVersionId && !deployedVersionIds.includes(activeVersionId)) {
    deployedVersionIds.push(activeVersionId);
  }
  return {
    workerName: context.workerName,
    activeVersionId,
    deployedVersionIds,
    versions: parseCloudflareVersions(versions.data),
  };
}

/** Return only versions that Cloudflare records as members of a production deployment. */
export function parseCloudflareDeployedVersionIds(value: unknown): Array<string> {
  const parsed = requireData(value, 'Cloudflare deployment list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare deployment list returned an unexpected response.');
  }
  const ids = new Set<string>();
  parsed.forEach((deployment, deploymentIndex) => {
    if (
      typeof deployment !== 'object' ||
      deployment === null ||
      !Array.isArray((deployment as Record<string, unknown>).versions)
    ) {
      throw new Error(`Cloudflare deployment list entry ${deploymentIndex + 1} is malformed.`);
    }
    for (const version of (deployment as { versions: Array<unknown> }).versions) {
      if (
        typeof version !== 'object' ||
        version === null ||
        typeof (version as Record<string, unknown>).version_id !== 'string' ||
        typeof (version as Record<string, unknown>).percentage !== 'number' ||
        !Number.isFinite((version as Record<string, number>).percentage) ||
        (version as Record<string, number>).percentage < 0 ||
        (version as Record<string, number>).percentage > 100
      ) {
        throw new Error(`Cloudflare deployment list entry ${deploymentIndex + 1} is malformed.`);
      }
      // A version staged at 0% for readiness is present in deployment history
      // even when its probe failed. It has never served production traffic and
      // must not become a rollback candidate.
      if ((version as { percentage: number }).percentage > 0) {
        ids.add((version as { version_id: string }).version_id);
      }
    }
  });
  return [...ids];
}

export function parseCloudflareVersions(value: unknown): Array<CloudflareWorkerVersion> {
  const parsed = requireData(value, 'Cloudflare version list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare version list returned an unexpected response.');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') {
      throw new Error(`Cloudflare version list entry ${index + 1} is malformed.`);
    }
    const metadata =
      typeof entry.metadata === 'object' && entry.metadata !== null
        ? (entry.metadata as Record<string, unknown>)
        : undefined;
    const annotations =
      typeof entry.annotations === 'object' && entry.annotations !== null
        ? (entry.annotations as Record<string, unknown>)
        : undefined;
    const message =
      typeof annotations?.['workers/message'] === 'string' ? annotations['workers/message'] : null;
    return {
      id: entry.id,
      createdAt: typeof metadata?.created_on === 'string' ? metadata.created_on : null,
      message,
      metadata: parseCloudflareVersionMessage(message),
    };
  });
}

export function parseActiveVersionId(value: unknown): string | null {
  const parsed = requireData(value, 'Cloudflare deployment status');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const deployment = parsed as Record<string, unknown>;
  if (!Array.isArray(deployment.versions)) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const versions = deployment.versions;
  const active = versions.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      Number((entry as Record<string, unknown>).percentage) === 100,
  );
  if (active === undefined) {
    return null;
  }
  if (
    typeof active !== 'object' ||
    active === null ||
    typeof (active as Record<string, unknown>).version_id !== 'string'
  ) {
    throw new Error('Cloudflare deployment status has a malformed active version.');
  }
  return (active as Record<string, string>).version_id;
}

export async function activateCloudflareExistingVersion(
  context: CloudflareOperationContext,
  target: CloudflareWorkerVersion,
  current?: CloudflareWorkerVersion,
): Promise<void> {
  // Without a complete snapshot, use Cloudflare's code-only rollback semantics.
  // Keeping triggers unchanged also makes the inverse recovery possible.
  if (
    target.metadata?.schema !== 2 ||
    target.metadata.triggerConfig.preserve ||
    !current ||
    current.metadata?.schema !== 2 ||
    current.metadata.triggerConfig.preserve
  ) {
    const owner = await readActiveCloudflareVersionId(context);
    if (current && owner !== current.id) {
      throw new Error(
        'Cloudflare production changed before rollback. Refresh deployment status and retry.',
      );
    }
    const result = await deployCloudflareVersionTraffic({
      ...context,
      percentages: [`${target.id}@100`],
      message: 'Void rollback preserving existing routes and triggers.',
    });
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error(
        'Cloudflare could not complete rollback. Refresh deployment status before retrying.',
      );
    }
    if ((await readActiveCloudflareVersionId(context)) !== target.id) {
      throw new Error(
        'Cloudflare rollback was superseded or could not be verified. Refresh deployment status.',
      );
    }
    return;
  }
  const targetTriggerConfig = target.metadata.triggerConfig;
  const publishedTraffic = readWranglerPublishedTrafficSnapshot(context.configPath);
  const currentTriggerConfig = publishedTraffic
    ? { ...current.metadata.triggerConfig, ...publishedTraffic }
    : current.metadata.triggerConfig;
  const message = encodeCloudflareVersionMessage(target.metadata.migrations, targetTriggerConfig);
  const ownerBeforeActivation = await readActiveCloudflareVersionId(context);
  if (ownerBeforeActivation !== current.id) {
    throw new Error(
      `Cloudflare production changed from ${current.id} to ${ownerBeforeActivation ?? 'no active version'} before rollback activation. Retry from fresh deployment status.`,
    );
  }
  await run(
    context,
    {
      type: 'versions.deploy',
      versions: [{ versionId: target.id, percentage: 100 }],
      configPath: context.configPath,
      workerName: context.workerName,
      message: message,
    },
    { capture: false },
  );
  const knownTriggerConfigs: Record<string, typeof targetTriggerConfig> = {
    [target.id]: targetTriggerConfig,
    [current.id]: currentTriggerConfig,
  };
  const stabilizeTriggers = (
    targetVersionId: string,
    targetConfig: typeof targetTriggerConfig,
    previousConfig: typeof targetTriggerConfig,
  ) =>
    stabilizeCloudflareVersionTriggers({
      runWrangler: context.runWrangler,
      workerName: context.workerName,
      configPath: context.configPath,
      targetVersionId,
      targetTriggerConfig: targetConfig,
      previousTriggerConfig: previousConfig,
      knownTriggerConfigs,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(context),
      publishEmptyCrons: createCloudflareEmptyCronPublisher(context),
    });
  const triggers = await stabilizeTriggers(target.id, targetTriggerConfig, currentTriggerConfig);
  if (triggers.ok && triggers.targetOwnsTraffic) {
    recordPublishedTraffic(context.configPath, targetTriggerConfig);
    return;
  }

  if (triggers.ok) {
    throw new Error(
      `Cloudflare rollback to ${target.id} was superseded by ${triggers.activeVersionId}; Void restored the active version's triggers. Refresh deployment status before retrying.`,
    );
  }
  if (triggers.activeVersionId && triggers.activeVersionId !== target.id) {
    throw new Error(
      `Cloudflare rollback to ${target.id} was superseded by ${triggers.activeVersionId}, but Void could not restore that version's triggers (${triggers.reason}). Inspect the Worker immediately.`,
    );
  }
  if (!triggers.activeVersionId) {
    throw new Error(
      `Cloudflare activated ${target.id}, but Void could not verify which version owns production while synchronizing triggers (${triggers.reason}). Inspect the Worker immediately.`,
    );
  }

  const ownerBeforeCompensation = await readActiveCloudflareVersionId(context);
  if (ownerBeforeCompensation !== target.id) {
    const repair = await stabilizeTriggers(target.id, targetTriggerConfig, currentTriggerConfig);
    throw new Error(
      repair.ok
        ? `Cloudflare rollback to ${target.id} was superseded by ${repair.activeVersionId}; Void restored the active version's triggers. Refresh deployment status before retrying.`
        : `Cloudflare rollback to ${target.id} was superseded by ${ownerBeforeCompensation ?? 'an unknown version'}, but Void could not restore the active triggers (${repair.reason}). Inspect the Worker immediately.`,
    );
  }
  let recoveryFailure: string | null = null;
  try {
    await run(
      context,
      {
        type: 'versions.deploy',
        versions: [{ versionId: current.id, percentage: 100 }],
        configPath: context.configPath,
        workerName: context.workerName,
        message: `Void automatic rollback after trigger synchronization failed.`,
        bypassDeploymentChecks: true,
      },
      { capture: false },
    );
    const restoredTriggers = await stabilizeTriggers(
      current.id,
      currentTriggerConfig,
      targetTriggerConfig,
    );
    if (!restoredTriggers.ok) {
      recoveryFailure = 'previous trigger synchronization failed';
    } else if (!restoredTriggers.targetOwnsTraffic) {
      recoveryFailure = `recovery was superseded by ${restoredTriggers.activeVersionId}`;
    } else {
      recordPublishedTraffic(context.configPath, currentTriggerConfig);
    }
  } catch (error) {
    recoveryFailure = getErrorMessage(error);
  }
  throw new Error(
    recoveryFailure
      ? `Cloudflare trigger synchronization failed after activating ${target.id}, and automatic recovery also failed: ${recoveryFailure}`
      : `Cloudflare trigger synchronization failed after activating ${target.id}; traffic and triggers were restored to ${current.id}.`,
  );
}

async function readActiveCloudflareVersionId(
  context: CloudflareOperationContext,
): Promise<string | null> {
  const result = await run(context, {
    type: 'deployments.status',
    configPath: context.configPath,
    workerName: context.workerName,
  });
  return parseActiveVersionId(result.data);
}

export async function tailCloudflareWorker(
  context: CloudflareOperationContext,
  options: { filter?: string; versionId?: string; status?: 'error' },
): Promise<void> {
  await run(
    context,
    {
      type: 'tail',
      workerName: context.workerName,
      configPath: context.configPath,
      search: options.filter,
      versionId: options.versionId,
      status: options.status,
    },
    { capture: false },
  );
}

export function listCloudflareDomains(root: string): Array<WranglerCustomDomain> {
  return readWranglerCustomDomains(root).domains;
}

export async function changeCloudflareDomain(
  root: string,
  hostname: string,
  action: 'add' | 'delete',
  runner?: CloudflareOperationRunner,
): Promise<{ modified: boolean; domains: Array<WranglerCustomDomain> }> {
  const context = resolveCloudflareOperationContext(root, runner);
  const before = readWranglerCustomDomains(root);
  const original = readFileSync(before.configPath, 'utf-8');
  const update = updateWranglerCustomDomain(root, hostname, action);
  if (!update.modified) {
    return update;
  }
  const triggerConfigDir = mkdtempSync(join(tmpdir(), 'void-domain-triggers-'));
  const triggerConfigPath = join(triggerConfigDir, 'wrangler.json');
  const deployRoutes = async (): Promise<void> => {
    if (readWranglerCustomDomains(root).domains.length === 0) {
      await publishEmptyCloudflareCustomDomainSet(context);
      return;
    }
    writeDomainTriggerConfig(context, before.configPath, triggerConfigPath);
    await run(
      context,
      { type: 'triggers.deploy', configPath: triggerConfigPath, workerName: context.workerName },
      { capture: false },
    );
  };
  try {
    await deployRoutes();
  } catch (error) {
    writeFileSync(before.configPath, original);
    persistCloudflareConfig(root);
    try {
      await deployRoutes();
    } catch (restoreError) {
      throw new Error(
        `Cloudflare rejected the domain trigger update and also rejected the automatic remote restore. ` +
          `The local Wrangler config was restored, but remote route state may be partially applied. ` +
          `${getErrorMessage(error)} Restore failed: ${getErrorMessage(restoreError)}`,
      );
    }
    throw new Error(
      `Cloudflare rejected the domain trigger update; both the local config and remote triggers were restored. ${getErrorMessage(error)}`,
    );
  } finally {
    rmSync(triggerConfigDir, { recursive: true, force: true });
  }
  recordPublishedTraffic(before.configPath, readCloudflareTriggerConfig(before.configPath));
  return update;
}

/** Remember the traffic attachment Void just published for later rollback diffs. */
function recordPublishedTraffic(
  configPath: string,
  config: Readonly<{ workers_dev: boolean; preview_urls: boolean; routes: ReadonlyArray<unknown> }>,
): void {
  writeWranglerPublishedTrafficSnapshot(configPath, {
    workers_dev: config.workers_dev,
    preview_urls: config.preview_urls,
    routes: [...config.routes],
  });
}

/**
 * Publish an explicit empty Custom Domain set through the pinned cf transport.
 * Trigger deploy omits empty domain sets; this operation must reconcile them
 * explicitly using the same verified browser/API credentials as other commands.
 */
export async function publishEmptyCloudflareCustomDomainSet(
  context: CloudflareOperationContext,
): Promise<void> {
  await run(context, {
    type: 'triggers.clear-domains',
    configPath: context.configPath,
    workerName: context.workerName,
  });
}

/** Adapt the direct empty-domain API call to the deployment package's result contract. */
export function createCloudflareEmptyDomainPublisher(
  context: CloudflareOperationContext,
): () => Promise<CloudflareCommandResult> {
  return async () => {
    try {
      await publishEmptyCloudflareCustomDomainSet(context);
      return { status: 0, stdout: '', stderr: '' };
    } catch (error) {
      return failedOperationResult(error);
    }
  };
}

/** Publish an explicit empty Cron Trigger set through Void's pinned cf transport. */
export function createCloudflareEmptyCronPublisher(
  context: CloudflareOperationContext,
): () => Promise<CloudflareCommandResult> {
  return async () => {
    try {
      return await run(context, {
        type: 'triggers.clear-crons',
        configPath: context.configPath,
        workerName: context.workerName,
      });
    } catch (error) {
      return failedOperationResult(error);
    }
  };
}

/**
 * Build a route-only Wrangler config for a domain update. `triggers deploy`
 * also reconciles cron, queue-consumer, and workflow triggers found in its
 * config, so using the root config here could drop generated schedules or
 * replay stale consumers. The isolated config carries only the route surface
 * this command owns and the workers.dev switches that route reconciliation
 * also evaluates.
 */
function writeDomainTriggerConfig(
  context: CloudflareOperationContext,
  sourceConfigPath: string,
  triggerConfigPath: string,
): void {
  const source = parseRootWranglerConfig(sourceConfigPath);
  const config: Record<string, unknown> = {
    name: context.workerName,
    account_id: context.accountId,
    routes: Array.isArray(source.routes) ? source.routes : [],
  };
  for (const field of ['workers_dev', 'preview_urls'] as const) {
    if (typeof source[field] === 'boolean') {
      config[field] = source[field];
    }
  }
  const compatibilityDate = readWranglerTopLevelString(source, 'compatibility_date');
  if (compatibilityDate) {
    config.compatibility_date = compatibilityDate;
  }
  writeFileSync(triggerConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function run(
  context: CloudflareOperationContext,
  args: CloudflareOperation,
  options?: { capture?: boolean; input?: string },
): Promise<CloudflareCommandResult> {
  const result = await Promise.resolve(
    context.runWrangler(args, {
      capture: options?.capture ?? true,
      input: options?.input,
    }),
  );
  if (
    result.status !== 0 ||
    result.signal != null ||
    (result.error !== undefined && result.error !== null && result.error !== '')
  ) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error || 'unknown error';
    throw new Error(`Cloudflare command failed (${args.type}, exit ${result.status}): ${detail}`);
  }
  return result;
}

function createCloudflareOperationRunner(
  root: string,
  accountId: string,
  apiBaseUrl: string,
): CloudflareOperationRunner {
  return createCloudflareProcessRunner({
    root,
    accountId,
    apiBaseUrl,
    env: () => {
      const env = provisionEnv({ accountId, apiBaseUrl });
      deleteEnvVarCaseAware(env, 'WRANGLER_CI_OVERRIDE_NAME');
      return env;
    },
  });
}

function assertNoOperationConfigOverride(root: string): void {
  const override = findAmbientConfigOverride();
  if (override === 'CLOUDFLARE_ENV') {
    throw new Error(
      'CLOUDFLARE_ENV is set. Void Cloudflare operations target the top-level config only.',
    );
  }
  if (override) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. Void Cloudflare operations use the root Wrangler config only.',
    );
  }
  const file = findWranglerCiOverrideDotenvFile(root);
  if (file) {
    throw new Error(
      `Project file "${file}" sets WRANGLER_CI_OVERRIDE_NAME, which can replace the pinned Worker name. Remove it before running this command.`,
    );
  }
}

function requireData(value: unknown, label: string): unknown {
  if (value === undefined) {
    throw new Error(label + ' did not return structured data.');
  }
  return value;
}

function failedOperationResult(error: unknown): CloudflareCommandResult {
  return { status: 1, stdout: '', stderr: getErrorMessage(error), error: getErrorMessage(error) };
}
