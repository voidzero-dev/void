import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, isRecord } from '@void/deploy-core';
import { join } from 'pathslash';
import { parseRootWranglerConfig } from './config.ts';
import { cloudflareCommandDiagnostic } from './diagnostics.ts';
import {
  isCleanCommandExit,
  isCompletedCommand,
  isWorkerNotFound,
  type CloudflareCommandResult,
  type CloudflareCommandRunner,
} from './execute.ts';
import type { CloudflareUploadResult } from './operations.ts';
import { isVoidSecretOnlyDraft, isWranglerSecretOnlyDraft } from './secret-draft.ts';

const DURABLE_MIGRATION_VERSION_ERROR = 10211;
const CLOUDFLARE_SECRET_CHANGED_ERROR = 10220;

export type CloudflareVersionMetadata =
  | Readonly<{
      schema: 1;
      migrations: ReadonlyArray<string>;
    }>
  | Readonly<{
      schema: 2;
      migrations: ReadonlyArray<string>;
      triggerConfig: CloudflareTriggerConfig;
      /** Digest of the complete Worker upload input, when supplied by the caller. */
      contentHash?: string;
    }>;

export type CloudflareTriggerConfig = Readonly<{
  /** This version retained the existing triggers instead of publishing a snapshot. */
  preserve?: boolean;
  preserveRoutes?: boolean;
  preserveWorkersDev?: boolean;
  preservePreviewUrls?: boolean;
  /** Fingerprint of explicit non-versioned settings while remote triggers stay opaque. */
  settingsHash?: string;
  /** Explicit Worker-wide observability settings, published after version activation. */
  observability?: Readonly<Record<string, unknown>>;
  workers_dev: boolean;
  preview_urls: boolean;
  routes: ReadonlyArray<unknown>;
  crons: ReadonlyArray<unknown>;
  queueConsumers: ReadonlyArray<unknown>;
  workflows: ReadonlyArray<unknown>;
  /**
   * Email Routing addresses (`addresses` in Wrangler config). The Cloudflare CLI applies its
   * Email Routing plan inside `triggers deploy` — `undefined` skips the plan entirely, while
   * `[]` is a destructive plan that deletes every rule this Worker owns — so the two must stay
   * distinct through the snapshot. Absent from annotations written before this field existed.
   */
  addresses?: ReadonlyArray<string>;
}>;

export type CloudflareTrafficConfig = Pick<
  CloudflareTriggerConfig,
  'workers_dev' | 'preview_urls' | 'routes'
>;

export type CloudflareVersionActivation =
  | {
      ok: true;
      versionId: string;
      previewUrl: string;
      previousVersionId: string | null;
      workersDevSubdomain?: string;
      preservedTriggers?: boolean;
      trafficConfig?: CloudflareTrafficConfig;
    }
  | {
      ok: false;
      reason:
        | 'uploader-changed'
        | 'status-failed'
        | 'deployment-changed'
        | 'inheritance-source-unavailable'
        | 'inheritance-source-changed'
        | 'traffic-preservation-unavailable'
        | 'traffic-split-unsupported'
        | 'upload-failed'
        | 'upload-output-invalid'
        | 'preview-unavailable'
        | 'readiness-staging-failed'
        | 'readiness-failed'
        | 'readiness-access-denied'
        | 'bootstrap-failed'
        | 'bootstrap-output-invalid'
        | 'bootstrap-readiness-failed'
        | 'bootstrap-readiness-access-denied'
        | 'atomic-failed'
        | 'atomic-output-invalid'
        | 'atomic-readiness-failed'
        | 'atomic-readiness-access-denied'
        | 'activation-failed'
        | 'triggers-failed';
      status?: number;
      cloudflareErrorCode?: number;
      /** Bounded uploader error text with terminal escapes removed and common credential formats redacted. */
      diagnostic?: string;
      /** Wrangler reached Cloudflare's Containers entitlement endpoint and received a 403. */
      containersUnavailable?: boolean;
      versionId?: string;
      previousVersionId?: string | null;
      rollback?: 'not-needed' | 'succeeded' | 'failed' | 'unavailable' | 'unsafe';
      /**
       * Cloudflare refused to restore the previous version because a secret
       * changed with this deploy, so Void forced it. The previous version runs
       * with its earlier secret values.
       */
      restoredOlderSecrets?: true;
      /** Version that owned production after a concurrent operation superseded this command. */
      activeVersionId?: string | null;
      /** Whether Void restored the active version's immutable trigger snapshot. */
      triggerRepair?: 'succeeded' | 'failed' | 'unavailable';
    };

type ProductionDeployment = Readonly<{
  versions?: ReadonlyArray<Readonly<{ version_id?: unknown; percentage?: unknown }>>;
}>;

type ProductionVersionPercentage = Readonly<{ versionId: string; percentage: number }>;

type CurrentProductionVersion =
  | {
      kind: 'ok';
      versionId: string | null;
      versions: ReadonlyArray<ProductionVersionPercentage>;
    }
  | { kind: 'failed'; status: number }
  | { kind: 'split' };

type RecentCloudflareVersion = Readonly<{
  id: string;
  number: number;
  inspection: Record<string, unknown>;
}>;

/** Encode migration state into Cloudflare's version annotation for safe rollback diagnostics. */
export function encodeCloudflareVersionMessage(
  migrations: ReadonlyArray<string>,
  triggerConfig?: CloudflareTriggerConfig,
  contentHash?: string,
): string {
  const metadata: CloudflareVersionMetadata = triggerConfig
    ? { schema: 2, migrations, triggerConfig, ...(contentHash ? { contentHash } : {}) }
    : { schema: 1, migrations };
  return `void:${JSON.stringify(metadata)}`;
}

/** Read migration state written by {@link encodeCloudflareVersionMessage}. */
export function parseCloudflareVersionMessage(
  message: string | null | undefined,
): CloudflareVersionMetadata | null {
  if (!message?.startsWith('void:')) {
    return null;
  }
  try {
    const value = JSON.parse(message.slice(5)) as {
      schema?: unknown;
      migrations?: unknown;
      triggerConfig?: unknown;
      contentHash?: unknown;
    };
    if (
      (value.schema !== 1 && value.schema !== 2) ||
      !Array.isArray(value.migrations) ||
      !value.migrations.every((migration): migration is string => typeof migration === 'string')
    ) {
      return null;
    }
    if (value.schema === 1) {
      // Schema 1 did not capture preview_urls and represented an omitted
      // workers_dev ambiguously. Keep its migration history, but never expose
      // its incomplete trigger state to rollback.
      return { schema: 1, migrations: value.migrations };
    }
    const triggerConfig = parseTriggerConfig(value.triggerConfig);
    if (!triggerConfig) {
      return null;
    }
    return {
      schema: 2,
      migrations: value.migrations,
      triggerConfig,
      ...(typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash)
        ? { contentHash: value.contentHash }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Capture shared configuration published after activation: routes, workers.dev / preview flags,
 * crons, queue consumers, workflows, Email Routing addresses, and explicit observability.
 */
export function readCloudflareTriggerConfig(
  configPath: string,
  sourceConfigPath?: string,
): CloudflareTriggerConfig {
  const config = parseRootWranglerConfig(configPath);
  // Build tooling can supply defaults; only authored settings may change the live Worker.
  const source = sourceConfigPath ? parseRootWranglerConfig(sourceConfigPath) : config;
  const result = triggerConfigFromWrangler({ ...config, observability: source.observability });
  if (!sourceConfigPath) {
    return result;
  }
  return {
    ...result,
    settingsHash: nonVersionedSettingsHash(source),
    ...(source.route === undefined && source.routes === undefined ? { preserveRoutes: true } : {}),
    ...(source.workers_dev === undefined ? { preserveWorkersDev: true } : {}),
    ...(source.preview_urls === undefined ? { preservePreviewUrls: true } : {}),
  };
}

/** Apply a version's persisted triggers and Worker settings using an isolated temporary config. */
export async function deployCloudflareVersionTriggers(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  configPath?: string;
  triggerConfig: CloudflareTriggerConfig;
  /** Exact trigger state active before this transition, used to remove stale state. */
  previousTriggerConfig?: CloudflareTriggerConfig;
  /** Wrangler skips an empty Custom Domain set, so the caller may publish it directly. */
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  /** cf skips an empty Cron Trigger set, so the caller may publish it directly. */
  publishEmptyCrons?: () => Promise<CloudflareCommandResult>;
  manageRoutes?: boolean;
}): Promise<CloudflareCommandResult> {
  if (options.triggerConfig.preserve) {
    return { status: 0, stdout: '', stderr: '' };
  }
  const source = options.configPath ? parseRootWranglerConfig(options.configPath) : {};
  // `triggers deploy` still validates unrelated upload configuration. Build a trigger-only
  // config so an ephemeral assets directory (or another bundle-only field) cannot break the
  // post-activation reconciliation after `versions upload` has already consumed it.
  const base = pickWranglerTriggerContext(source);
  const config = triggerWranglerConfig(
    base,
    triggerConfigWithRemovedWorkflowSchedules(
      options.workerName,
      options.triggerConfig,
      options.previousTriggerConfig,
    ),
    options.manageRoutes,
  );
  const directory = mkdtempSync(join(tmpdir(), 'void-version-triggers-'));
  const configPath = join(directory, 'wrangler.json');
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const deployed = await options.runWrangler(
      { type: 'triggers.deploy', configPath, workerName: options.workerName },
      { capture: false },
    );
    if (!isCleanCommandExit(deployed)) {
      return deployed;
    }
    if (options.triggerConfig.crons.length === 0 && options.publishEmptyCrons) {
      const published = await options.publishEmptyCrons();
      if (!isCleanCommandExit(published)) {
        return published;
      }
    }
    for (const queue of removedQueueConsumers(
      options.triggerConfig,
      options.previousTriggerConfig,
    )) {
      const removed = await options.runWrangler(
        {
          type: 'queues.consumer.remove',
          queueName: queue,
          workerName: options.workerName,
          configPath,
        },
        { capture: false },
      );
      if (!isCleanCommandExit(removed)) {
        return removed;
      }
    }
    if (
      options.manageRoutes !== false &&
      !options.triggerConfig.preserveRoutes &&
      hasCustomDomains(options.previousTriggerConfig?.routes) &&
      !hasCustomDomains(options.triggerConfig.routes)
    ) {
      if (!options.publishEmptyCustomDomains) {
        return {
          status: 1,
          stdout: '',
          stderr:
            'Cloudflare could not publish an empty Custom Domain set and no direct publisher was available.',
        };
      }
      const published = await options.publishEmptyCustomDomains();
      if (!isCleanCommandExit(published)) {
        return published;
      }
    }
    return deployed;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function pickWranglerTriggerContext(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['account_id', 'name', 'legacy_env', 'send_metrics', 'compliance_region']) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

export type CloudflareTriggerStabilization =
  | Readonly<{
      ok: true;
      activeVersionId: string;
      targetOwnsTraffic: boolean;
    }>
  | Readonly<{
      ok: false;
      reason: 'status-failed' | 'traffic-split' | 'metadata-unavailable' | 'triggers-failed';
      status?: number;
      activeVersionId?: string | null;
    }>;

/**
 * Reconcile triggers to the version that actually owns production traffic.
 *
 * Worker Version activation and `wrangler triggers deploy` are separate Cloudflare operations.
 * Another deploy or rollback can therefore take ownership between them. Re-read ownership before
 * and after every trigger publication and, when it changes, repair the new owner's immutable
 * schema-2 snapshot. The bounded loop fails closed if traffic never stabilizes.
 */
export async function stabilizeCloudflareVersionTriggers(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  configPath?: string;
  targetVersionId: string;
  targetTriggerConfig: CloudflareTriggerConfig;
  previousTriggerConfig?: CloudflareTriggerConfig;
  knownTriggerConfigs?: Readonly<Record<string, CloudflareTriggerConfig>>;
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  publishEmptyCrons?: () => Promise<CloudflareCommandResult>;
  manageRoutes?: boolean;
  attempts?: number;
}): Promise<CloudflareTriggerStabilization> {
  let cleanupBaseline = mergeTriggerCleanupBaselines(
    options.previousTriggerConfig,
    options.targetTriggerConfig,
  );
  const attempts = Math.max(1, options.attempts ?? 4);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const owner = await readCurrentProductionVersion(options);
    if (owner.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: owner.status };
    }
    if (owner.kind === 'split') {
      return { ok: false, reason: 'traffic-split' };
    }
    if (!owner.versionId) {
      return { ok: false, reason: 'metadata-unavailable', activeVersionId: null };
    }

    const activeVersionId = owner.versionId;
    let activeTriggerConfig =
      activeVersionId === options.targetVersionId
        ? options.targetTriggerConfig
        : options.knownTriggerConfigs?.[activeVersionId];
    if (!activeTriggerConfig && activeVersionId !== options.targetVersionId) {
      const metadata = await readCloudflareVersionMetadata(options, activeVersionId);
      activeTriggerConfig = metadata?.schema === 2 ? metadata.triggerConfig : undefined;
    }
    if (!activeTriggerConfig) {
      return { ok: false, reason: 'metadata-unavailable', activeVersionId };
    }

    const triggers = await deployCloudflareVersionTriggers({
      runWrangler: options.runWrangler,
      workerName: options.workerName,
      configPath: options.configPath,
      triggerConfig: activeTriggerConfig,
      previousTriggerConfig: cleanupBaseline,
      publishEmptyCustomDomains: options.publishEmptyCustomDomains,
      publishEmptyCrons: options.publishEmptyCrons,
      manageRoutes: options.manageRoutes,
    });
    if (!isCleanCommandExit(triggers)) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        activeVersionId,
      };
    }

    cleanupBaseline = mergeTriggerCleanupBaselines(cleanupBaseline, activeTriggerConfig);
    const after = await readCurrentProductionVersion(options);
    if (after.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: after.status };
    }
    if (after.kind === 'split') {
      return { ok: false, reason: 'traffic-split' };
    }
    if (after.versionId === activeVersionId) {
      return {
        ok: true,
        activeVersionId,
        targetOwnsTraffic: activeVersionId === options.targetVersionId,
      };
    }
  }

  return { ok: false, reason: 'status-failed' };
}

function triggerRepairOutcome(
  result: CloudflareTriggerStabilization,
): 'succeeded' | 'failed' | 'unavailable' {
  if (result.ok) {
    return 'succeeded';
  }
  return result.reason === 'metadata-unavailable' ? 'unavailable' : 'failed';
}

function mergeTriggerCleanupBaselines(
  ...configs: Array<CloudflareTriggerConfig | undefined>
): CloudflareTriggerConfig {
  const present = configs.filter(
    (config): config is CloudflareTriggerConfig => config !== undefined,
  );
  const unique = (values: ReadonlyArray<unknown>): Array<unknown> => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  };
  // Keep `addresses` absent when no config carried a plan (see CloudflareTriggerConfig).
  const withAddresses = present.filter((config) => config.addresses !== undefined);
  return {
    workers_dev: present.some((config) => config.workers_dev),
    preview_urls: present.some((config) => config.preview_urls),
    routes: unique(present.flatMap((config) => config.routes)),
    crons: unique(present.flatMap((config) => config.crons)),
    queueConsumers: unique(present.flatMap((config) => config.queueConsumers)),
    workflows: unique(present.flatMap((config) => config.workflows)),
    ...(withAddresses.length === 0
      ? {}
      : { addresses: [...new Set(withAddresses.flatMap((config) => config.addresses ?? []))] }),
  };
}

function removedQueueConsumers(
  desired: CloudflareTriggerConfig,
  previous: CloudflareTriggerConfig | undefined,
): Array<string> {
  if (!previous) {
    return [];
  }
  const desiredQueues = new Set(queueConsumerNames(desired.queueConsumers));
  return queueConsumerNames(previous.queueConsumers)
    .filter((queue) => !desiredQueues.has(queue))
    .sort();
}

function queueConsumerNames(consumers: ReadonlyArray<unknown>): Array<string> {
  return [
    ...new Set(
      consumers.flatMap((consumer) =>
        isRecord(consumer) && typeof consumer.queue === 'string' ? [consumer.queue] : [],
      ),
    ),
  ];
}

function triggerConfigWithQueueConsumerCleanup(
  previous: CloudflareTriggerConfig | undefined,
  cleanup: ReadonlyArray<string> | undefined,
): CloudflareTriggerConfig | undefined {
  const queues = [...new Set((cleanup ?? []).filter((queue) => queue.length > 0))];
  if (queues.length === 0) {
    return previous;
  }
  // A concurrent rollback replays this copy verbatim, so spread every snapshot field.
  const base: CloudflareTriggerConfig = previous ?? {
    workers_dev: false,
    preview_urls: false,
    routes: [],
    crons: [],
    queueConsumers: [],
    workflows: [],
  };
  return {
    ...base,
    queueConsumers: [
      ...base.queueConsumers,
      ...queues
        .filter((queue) => !queueConsumerNames(base.queueConsumers).includes(queue))
        .map((queue) => ({ queue })),
    ],
  };
}

function triggerConfigWithRemovedWorkflowSchedules(
  workerName: string,
  desired: CloudflareTriggerConfig,
  previous: CloudflareTriggerConfig | undefined,
): CloudflareTriggerConfig {
  if (!previous) {
    return desired;
  }
  const desiredNames = new Set(
    desired.workflows.flatMap((workflow) =>
      isRecord(workflow) && typeof workflow.name === 'string' ? [workflow.name] : [],
    ),
  );
  const removed = previous.workflows.flatMap((workflow) => {
    if (
      !isRecord(workflow) ||
      typeof workflow.name !== 'string' ||
      typeof workflow.class_name !== 'string' ||
      desiredNames.has(workflow.name) ||
      (typeof workflow.script_name === 'string' && workflow.script_name !== workerName)
    ) {
      return [];
    }
    return [{ ...workflow, schedules: [] }];
  });
  return removed.length === 0
    ? desired
    : { ...desired, workflows: [...desired.workflows, ...removed] };
}

function hasCustomDomains(routes: ReadonlyArray<unknown> | undefined): boolean {
  return routes?.some((route) => isRecord(route) && route.custom_domain === true) === true;
}

/** Select a configured HTTPS route that is guaranteed to cover /__void/ready. */
function customRouteReadinessUrl(routes: ReadonlyArray<unknown>): string | undefined {
  for (const route of routes) {
    const record = isRecord(route) ? route : undefined;
    const pattern =
      typeof route === 'string'
        ? route
        : typeof record?.pattern === 'string'
          ? record.pattern
          : undefined;
    if (!pattern) {
      continue;
    }
    const customDomain = record?.custom_domain === true;
    const withoutScheme = pattern.replace(/^https?:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    const hostname = (slash < 0 ? withoutScheme : withoutScheme.slice(0, slash)).trim();
    const path = slash < 0 ? '' : withoutScheme.slice(slash);
    if (!hostname || hostname.includes('*') || (!customDomain && path !== '/*' && path !== '*')) {
      continue;
    }
    return `https://${hostname}`;
  }
  return undefined;
}

function triggerConfigFromWrangler(config: Record<string, unknown>): CloudflareTriggerConfig {
  const triggers = isRecord(config.triggers) ? config.triggers : {};
  const queues = isRecord(config.queues) ? config.queues : {};
  const routes = Array.isArray(config.routes)
    ? config.routes
    : config.route === undefined
      ? []
      : [config.route];
  // Wrangler disables workers.dev by default when an explicit route is
  // configured. Persist the effective value so trigger publication and
  // rollback do not accidentally reopen the public workers.dev hostname.
  const workersDev =
    typeof config.workers_dev === 'boolean' ? config.workers_dev : routes.length === 0;
  const addresses = readEmailAddresses(config.addresses);
  return {
    ...(config.routes === undefined && config.route === undefined ? { preserveRoutes: true } : {}),
    ...(config.workers_dev === undefined ? { preserveWorkersDev: true } : {}),
    ...(config.preview_urls === undefined ? { preservePreviewUrls: true } : {}),
    settingsHash: nonVersionedSettingsHash(config),
    ...(isRecord(config.observability) ? { observability: config.observability } : {}),
    workers_dev: workersDev,
    preview_urls: typeof config.preview_urls === 'boolean' ? config.preview_urls : workersDev,
    routes,
    crons: Array.isArray(triggers.crons) ? triggers.crons : [],
    queueConsumers: Array.isArray(queues.consumers) ? queues.consumers : [],
    workflows: Array.isArray(config.workflows) ? config.workflows : [],
    ...(addresses === undefined ? {} : { addresses }),
  };
}

/** Trigger state recorded by a schema-2 version message, otherwise read from local config. */
function desiredTriggerConfigFor(
  metadata: CloudflareVersionMetadata | null,
  configPath: string | undefined,
): CloudflareTriggerConfig {
  if (metadata?.schema === 2) {
    return metadata.triggerConfig;
  }
  return configPath ? readCloudflareTriggerConfig(configPath) : triggerConfigFromWrangler({});
}

/** A well-formed `addresses` array, or `undefined` when the field is absent or malformed. */
function readEmailAddresses(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as ReadonlyArray<string>)
    : undefined;
}

function nonVersionedSettingsHash(config: Record<string, unknown>): string {
  const settings = Object.fromEntries(
    ['logpush', 'observability', 'tail_consumers', 'streaming_tail_consumers']
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
  return createHash('sha256').update(canonicalJson(settings)).digest('hex');
}

function parseTriggerConfig(value: unknown): CloudflareTriggerConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    ['preserve', 'preserveRoutes', 'preserveWorkersDev', 'preservePreviewUrls'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    ) ||
    (value.settingsHash !== undefined && typeof value.settingsHash !== 'string') ||
    (value.observability !== undefined && !isRecord(value.observability)) ||
    typeof value.workers_dev !== 'boolean' ||
    typeof value.preview_urls !== 'boolean' ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.crons) ||
    !Array.isArray(value.queueConsumers) ||
    !Array.isArray(value.workflows) ||
    (value.addresses !== undefined && readEmailAddresses(value.addresses) === undefined)
  ) {
    return null;
  }
  return {
    ...(value.preserve === true ? { preserve: true } : {}),
    ...(value.preserveRoutes === true ? { preserveRoutes: true } : {}),
    ...(value.preserveWorkersDev === true ? { preserveWorkersDev: true } : {}),
    ...(value.preservePreviewUrls === true ? { preservePreviewUrls: true } : {}),
    ...(typeof value.settingsHash === 'string' ? { settingsHash: value.settingsHash } : {}),
    ...(isRecord(value.observability) ? { observability: value.observability } : {}),
    workers_dev: value.workers_dev,
    preview_urls: value.preview_urls,
    routes: value.routes,
    crons: value.crons,
    queueConsumers: value.queueConsumers,
    workflows: value.workflows,
    ...(value.addresses === undefined ? {} : { addresses: value.addresses as Array<string> }),
  };
}

function triggerWranglerConfig(
  base: Record<string, unknown>,
  triggerConfig: CloudflareTriggerConfig,
  manageRoutes = true,
): Record<string, unknown> {
  const triggers = isRecord(base.triggers) ? { ...base.triggers } : {};
  const queues = isRecord(base.queues) ? { ...base.queues } : {};
  triggers.crons = [...triggerConfig.crons];
  queues.consumers = [...triggerConfig.queueConsumers];
  const config: Record<string, unknown> = {
    ...base,
    ...(triggerConfig.observability === undefined
      ? {}
      : { observability: triggerConfig.observability }),
    triggers,
    queues,
    workflows: [...triggerConfig.workflows],
    workers_dev: triggerConfig.workers_dev,
    preview_urls: triggerConfig.preview_urls,
  };
  if (manageRoutes && !triggerConfig.preserveRoutes) {
    config.routes = [...triggerConfig.routes];
  }
  // Replay only a recorded plan; `[]` would delete every Email Routing rule this Worker owns.
  if (triggerConfig.addresses !== undefined) {
    config.addresses = [...triggerConfig.addresses];
  }
  if (triggerConfig.preserveWorkersDev) {
    delete config.workers_dev;
  }
  if (triggerConfig.preservePreviewUrls) {
    delete config.preview_urls;
  }
  delete config.route;
  return config;
}

function resolvePreservedTraffic(
  desired: CloudflareTriggerConfig,
  previous: CloudflareTrafficConfig | undefined,
  workerExists: boolean,
): CloudflareTriggerConfig | null {
  const preservesTraffic =
    desired.preserveRoutes || desired.preserveWorkersDev || desired.preservePreviewUrls;
  if (preservesTraffic && workerExists && !previous) {
    return null;
  }
  return {
    ...(desired.preserve ? { preserve: true } : {}),
    ...(desired.settingsHash ? { settingsHash: desired.settingsHash } : {}),
    ...(desired.observability === undefined ? {} : { observability: desired.observability }),
    workers_dev: desired.preserveWorkersDev
      ? (previous?.workers_dev ?? desired.workers_dev)
      : desired.workers_dev,
    preview_urls: desired.preservePreviewUrls
      ? (previous?.preview_urls ?? desired.preview_urls)
      : desired.preview_urls,
    routes: desired.preserveRoutes ? (previous?.routes ?? desired.routes) : desired.routes,
    crons: desired.crons,
    queueConsumers: desired.queueConsumers,
    workflows: desired.workflows,
    // Not a traffic surface, but dropping it would skip Wrangler's Email Routing plan.
    ...(desired.addresses === undefined ? {} : { addresses: desired.addresses }),
  };
}

function isCandidatePreviewUrl(
  value: string,
  workerName: string,
  versionId: string,
  alias: string,
): boolean {
  try {
    const url = new URL(value);
    const label = url.hostname.split('.')[0];
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      extractWorkersDevSubdomain(value) !== undefined &&
      (label === `${versionId.slice(0, 8)}-${workerName}` || label === `${alias}-${workerName}`)
    );
  } catch {
    return false;
  }
}

export type CloudflareVersionActivationOptions = {
  /** Human-readable deployment phases; the caller owns terminal rendering. */
  onProgress?: (message: string) => void;
  /** Reuse an inspected Worker without republishing its domains or other triggers. */
  preserveTriggers?: boolean;
  expectedPreviousVersionId?: string;
  trustedInheritanceVersionIds?: ReadonlyArray<string>;
  recordVerifiedCandidate?: (
    versionId: string,
    parentVersionId: string | null,
  ) => void | Promise<void>;
  validateUploadedVersion?: (versionId: string) => Promise<void>;
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  workerName: string;
  configPath?: string;
  /** Override only the asset directory for this upload, leaving the persisted config intact. */
  assetsDirectoryOverride?: string;
  /** Optional Cloudflare Access headers used only by the readiness probe. */
  readinessHeaders?: Readonly<Record<string, string>>;
  /** Account workers.dev subdomain used when this Worker cannot expose version preview URLs. */
  workersDevSubdomain?: string;
  /**
   * Operator-provided workers.dev subdomain that may receive readiness credentials even when
   * Wrangler cannot report a preview URL. Cached/project-controlled values must not be used here.
   */
  readinessHeadersWorkersDevSubdomain?: string;
  message: string;
  /** Direct empty-domain publisher for the Wrangler reconciliation gap. */
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  publishEmptyCrons?: () => Promise<CloudflareCommandResult>;
  /** Last successfully published traffic state, newer than immutable version annotations. */
  previousTrafficConfig?: CloudflareTrafficConfig;
  /** Explicitly Void-owned queue consumers retained for schema-1 cleanup and failed retries. */
  queueConsumerCleanup?: ReadonlyArray<string>;
  /**
   * The caller proved that the Worker did not exist before this deploy provisioned its secrets.
   * Wrangler creates an active placeholder version when attaching the first secret, so the status
   * read below can legitimately observe a version even though no application was ever deployed.
   */
  allowFirstDeploymentBootstrap?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessAttempts?: number;
  /** Require readiness to report the uploaded Worker's actual version UUID. */
  requireVersionMetadata?: boolean;
  /** A binding-preserving handoff without metadata may use only a genuine version preview. */
  requirePreviewForReadiness?: boolean;
  /** Verify that omitted remote secrets come from the active Worker Version before uploading. */
  verifyInheritedSecrets?: boolean;
  /** Pin inherited opaque secret bindings to the inspected live version before uploading. */
  pinActiveSecrets?: (
    activeVersionId: string,
    bindings: ReadonlyArray<{ name: string; type: 'secret_text' | 'secret_key' }>,
  ) => Promise<boolean> | boolean;
  /** Explicitly publish an existing Durable Object Worker in one atomic operation. */
  atomic?: boolean;
  /**
   * Plaintext secrets to attach only to the uploaded candidate version. Supplying every remote
   * `secret_text` binding lets a deployment recover safely when an inactive upload is newer than
   * production; `secret_key` bindings cannot be replaced through this option.
   */
  candidateSecrets?: Readonly<Record<string, string>>;
};

type InternalCloudflareVersionActivationOptions = CloudflareVersionActivationOptions & {
  candidateSecretsFilePath?: string;
};

/** Upload, probe, and atomically activate a verified Worker Version. */
export async function activateCloudflareVersion(
  options: CloudflareVersionActivationOptions,
): Promise<CloudflareVersionActivation> {
  const candidateSecrets = Object.entries(options.candidateSecrets ?? {});
  if (candidateSecrets.length === 0) {
    return activateCloudflareVersionWithSecretsFile(options);
  }

  const directory = mkdtempSync(join(tmpdir(), 'void-version-secrets-'));
  const path = join(directory, 'secrets.json');
  try {
    writeFileSync(path, `${JSON.stringify(Object.fromEntries(candidateSecrets))}\n`, {
      mode: 0o600,
    });
    return await activateCloudflareVersionWithSecretsFile({
      ...options,
      candidateSecretsFilePath: path,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function activateCloudflareVersionWithSecretsFile(
  options: InternalCloudflareVersionActivationOptions,
): Promise<CloudflareVersionActivation> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  options.onProgress?.('Checking the current Worker deployment...');
  const previous = await readCurrentProductionVersion(options);
  if (previous.kind === 'failed') {
    return { ok: false, reason: 'status-failed', status: previous.status };
  }
  if (previous.kind === 'split') {
    return { ok: false, reason: 'traffic-split-unsupported' };
  }
  if (
    options.expectedPreviousVersionId !== undefined &&
    previous.versionId !== options.expectedPreviousVersionId
  ) {
    return {
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: previous.versionId,
      rollback: 'not-needed',
    };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const previousVersionId = previous.versionId;
  if (options.atomic && options.requirePreviewForReadiness) {
    return {
      ok: false,
      reason: 'preview-unavailable',
      previousVersionId,
      rollback: 'not-needed',
      diagnostic:
        'This binding-preserving handoff requires a candidate preview before activation. Configure version metadata on the existing Worker or retry without atomic publication; production traffic is unchanged.',
    };
  }
  // Activation can succeed before trigger synchronization or the local receipt
  // cleanup fails. Once its last recorded candidate owns all live traffic, the
  // receipt no longer authorizes any *inactive* successor. The history checks
  // below still reject a newer upload from another operation.
  const trustedInheritanceVersionIds =
    previousVersionId && options.trustedInheritanceVersionIds?.at(-1) === previousVersionId
      ? []
      : options.trustedInheritanceVersionIds;
  let inheritanceBaseline: Array<RecentCloudflareVersion> | undefined;
  let trustedCandidateChain = false;
  let activeSecretsPinned = false;
  let pinnedActiveSecrets: Array<{ name: string; type: 'secret_key' | 'secret_text' }> | undefined;
  if (options.expectedPreviousVersionId !== undefined || options.verifyInheritedSecrets === true) {
    const recent = await readRecentCloudflareVersionIds(options);
    if (recent === null) {
      return { ok: false, reason: 'inheritance-source-unavailable' };
    }
    const latestVersionId = recent.at(-1)?.id ?? null;
    if (
      options.expectedPreviousVersionId !== undefined ||
      trustedInheritanceVersionIds !== undefined
    ) {
      const activeIndex = recent.findIndex((version) => version.id === previous.versionId);
      const inheritedChain = activeIndex < 0 ? [] : recent.slice(activeIndex);
      const inheritedCandidates = inheritedChain.slice(1).map((version) => version.id);
      trustedCandidateChain =
        trustedInheritanceVersionIds !== undefined &&
        trustedInheritanceVersionIds.length > 0 &&
        arraysEqual(inheritedCandidates, trustedInheritanceVersionIds);
      const safeInheritanceChain =
        inheritedChain.length > 0 &&
        inheritedChain.every(
          (version, index) =>
            index === 0 || version.number === inheritedChain[index - 1]!.number + 1,
        ) &&
        (arraysEqual(inheritedCandidates, trustedInheritanceVersionIds ?? []) ||
          options.pinActiveSecrets !== undefined);
      if (!safeInheritanceChain) {
        return {
          ok: false,
          reason: 'inheritance-source-changed',
          activeVersionId: recent.at(-1)?.id ?? null,
          rollback: 'not-needed',
        };
      }
    }
    if (
      options.verifyInheritedSecrets === true &&
      previous.versionId !== latestVersionId &&
      !trustedCandidateChain
    ) {
      const replacesAllRemoteSecrets = await candidateReplacesAllRemoteSecrets(
        options,
        previous.versionId,
        latestVersionId,
      );
      if (replacesAllRemoteSecrets === null) {
        return { ok: false, reason: 'inheritance-source-unavailable' };
      }
      if (!replacesAllRemoteSecrets) {
        const activeSecrets = previous.versionId
          ? await readCloudflareVersionSecretBindings(options, previous.versionId)
          : null;
        if (
          !activeSecrets ||
          !options.pinActiveSecrets ||
          !(await options.pinActiveSecrets(previous.versionId!, activeSecrets))
        ) {
          return {
            ok: false,
            reason: 'inheritance-source-changed',
            activeVersionId: latestVersionId,
            rollback: 'not-needed',
          };
        }
        activeSecretsPinned = true;
        pinnedActiveSecrets = activeSecrets;
      }
    }
    inheritanceBaseline = recent;
  }
  const desiredMetadata = parseCloudflareVersionMessage(options.message);
  let desiredTriggerConfig = desiredTriggerConfigFor(desiredMetadata, options.configPath);
  let previousVersion =
    previousVersionId && desiredMetadata?.schema === 2
      ? await readCloudflareVersionInspection(
          options,
          previousVersionId,
          inheritanceBaseline?.map((version) => version.inspection),
        )
      : null;
  async function previousIsSecretOnlyDraft(): Promise<boolean> {
    if (!previousVersionId) {
      return false;
    }
    previousVersion ??= await readCloudflareVersionInspection(
      options,
      previousVersionId,
      inheritanceBaseline?.map((version) => version.inspection),
    );
    return previousVersion?.isSecretOnlyDraft === true;
  }
  const previousMetadata = desiredMetadata?.schema === 2 ? previousVersion?.metadata : null;
  const continuesOpaqueTriggerPreservation =
    !options.preserveTriggers &&
    !options.previousTrafficConfig &&
    previousMetadata?.schema === 2 &&
    previousMetadata.triggerConfig.preserve === true &&
    desiredTriggerConfig.settingsHash === previousMetadata.triggerConfig.settingsHash &&
    (desiredTriggerConfig.preserveRoutes === true ||
      desiredTriggerConfig.preserveWorkersDev === true ||
      desiredTriggerConfig.preservePreviewUrls === true) &&
    (desiredTriggerConfig.preserveRoutes === true ||
      isDeepStrictEqual(desiredTriggerConfig.routes, previousMetadata.triggerConfig.routes)) &&
    (desiredTriggerConfig.preserveWorkersDev === true ||
      desiredTriggerConfig.workers_dev === previousMetadata.triggerConfig.workers_dev) &&
    (desiredTriggerConfig.preservePreviewUrls === true ||
      desiredTriggerConfig.preview_urls === previousMetadata.triggerConfig.preview_urls) &&
    desiredTriggerConfig.crons.length === 0 &&
    desiredTriggerConfig.queueConsumers.length === 0 &&
    desiredTriggerConfig.workflows.length === 0;
  const previousTrafficConfig =
    options.previousTrafficConfig ??
    (previousMetadata?.schema === 2 && previousMetadata.triggerConfig.preserve !== true
      ? {
          workers_dev: previousMetadata.triggerConfig.workers_dev,
          preview_urls: previousMetadata.triggerConfig.preview_urls,
          routes: previousMetadata.triggerConfig.routes,
        }
      : undefined);
  if (continuesOpaqueTriggerPreservation) {
    desiredTriggerConfig = { ...desiredTriggerConfig, preserve: true };
  } else if (!options.preserveTriggers && desiredMetadata?.schema === 2) {
    const resolved = resolvePreservedTraffic(
      desiredTriggerConfig,
      previousTrafficConfig,
      previous.versionId !== null && !(await previousIsSecretOnlyDraft()),
    );
    if (!resolved) {
      return {
        ok: false,
        reason: 'traffic-preservation-unavailable',
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    desiredTriggerConfig = resolved;
  }
  const message =
    desiredMetadata?.schema === 2
      ? encodeCloudflareVersionMessage(desiredMetadata.migrations, desiredTriggerConfig)
      : options.message;
  const versionedPreviousTriggerConfig =
    previousMetadata?.schema === 2 ? previousMetadata.triggerConfig : undefined;
  const versionedPreviousTriggerConfigWithTraffic =
    versionedPreviousTriggerConfig && previousTrafficConfig
      ? { ...versionedPreviousTriggerConfig, ...previousTrafficConfig }
      : versionedPreviousTriggerConfig;
  const previousTriggerConfig = triggerConfigWithQueueConsumerCleanup(
    versionedPreviousTriggerConfigWithTraffic,
    options.queueConsumerCleanup,
  );

  const alias = `void-ready-${Date.now().toString(36)}`;
  const bootstrapVoidDraft =
    !options.preserveTriggers &&
    !options.requirePreviewForReadiness &&
    previousVersion?.isVoidSecretOnlyDraft === true;
  if (previous.versionId !== null && (options.atomic || bootstrapVoidDraft)) {
    // The exact private cf placeholder has no serving preview. Publish its first
    // application once through the bootstrap path, pinning its active secrets
    // just as for an explicitly atomic release.
    if (bootstrapVoidDraft && !activeSecretsPinned && !options.pinActiveSecrets) {
      return { ok: false, reason: 'inheritance-source-unavailable' };
    }
    if (bootstrapVoidDraft || (!activeSecretsPinned && options.pinActiveSecrets)) {
      let activeSecrets: Awaited<ReturnType<typeof readCloudflareVersionSecretBindings>>;
      try {
        activeSecrets = await readCloudflareVersionSecretBindings(options, previous.versionId);
      } catch {
        return { ok: false, reason: 'inheritance-source-unavailable' };
      }
      if (activeSecrets === null) {
        return { ok: false, reason: 'inheritance-source-unavailable' };
      }
      if (
        bootstrapVoidDraft &&
        (activeSecrets.length === 0 ||
          activeSecrets.some((secret) => secret.type !== 'secret_text') ||
          !arraysEqual(
            activeSecrets.map((secret) => secret.name).sort(),
            [...previousVersion!.voidDraftSecretNames!].sort(),
          ) ||
          (activeSecretsPinned &&
            !isDeepStrictEqual(
              [...activeSecrets].sort((a, b) => a.name.localeCompare(b.name)),
              [...pinnedActiveSecrets!].sort((a, b) => a.name.localeCompare(b.name)),
            )))
      ) {
        return { ok: false, reason: 'inheritance-source-changed' };
      }
      if (!activeSecretsPinned && activeSecrets.length) {
        let pinned: boolean;
        try {
          pinned = await options.pinActiveSecrets!(previous.versionId, activeSecrets);
        } catch {
          return { ok: false, reason: 'inheritance-source-unavailable' };
        }
        if (!pinned) {
          return { ok: false, reason: 'inheritance-source-changed' };
        }
      }
    }
    return bootstrapFirstDeployment(
      { ...options, message },
      previous.versionId,
      options.atomic === true,
      previousTriggerConfig,
    );
  }
  // The ordinary cf uploader refuses a non-interactive revision of an API-origin
  // Worker. Keep inherited secrets on the same UUID-pinned upload path used by
  // bootstrap, rather than bypassing cf's general overwrite confirmation. An
  // explicitly supplied replacement retains its existing upload semantics.
  if (
    previous.versionId !== null &&
    !activeSecretsPinned &&
    options.pinActiveSecrets &&
    options.candidateSecretsFilePath === undefined
  ) {
    let activeSecrets: Awaited<ReturnType<typeof readCloudflareVersionSecretBindings>>;
    try {
      activeSecrets = await readCloudflareVersionSecretBindings(options, previous.versionId);
    } catch {
      return { ok: false, reason: 'inheritance-source-unavailable' };
    }
    if (activeSecrets === null) {
      return { ok: false, reason: 'inheritance-source-unavailable' };
    }
    if (
      activeSecrets.some((secret) => !secret.name.trim() || secret.name.trim() !== secret.name) ||
      new Set(activeSecrets.map((secret) => secret.name)).size !== activeSecrets.length
    ) {
      return { ok: false, reason: 'inheritance-source-changed' };
    }
    if (activeSecrets.length) {
      let pinned: boolean;
      try {
        pinned = await options.pinActiveSecrets(previous.versionId, activeSecrets);
      } catch {
        return { ok: false, reason: 'inheritance-source-unavailable' };
      }
      if (!pinned) {
        return { ok: false, reason: 'inheritance-source-changed' };
      }
      activeSecretsPinned = true;
    }
  }
  if (activeSecretsPinned) {
    if (!options.verifyUploader()) {
      return { ok: false, reason: 'uploader-changed' };
    }
    const owner = await readCurrentProductionVersion(options);
    if (owner.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: owner.status };
    }
    if (
      owner.kind !== 'ok' ||
      owner.versionId !== previous.versionId ||
      !productionVersionPercentagesEqual(owner.versions, [
        { versionId: previous.versionId!, percentage: 100 },
      ])
    ) {
      return {
        ok: false,
        reason: 'deployment-changed',
        activeVersionId: owner.kind === 'ok' ? owner.versionId : null,
        rollback: 'not-needed',
      };
    }
  }
  options.onProgress?.('Uploading the Worker and assets...');
  const upload = await options.runWrangler(
    {
      type: 'versions.upload',
      configPath: options.configPath,
      workerName: options.workerName,
      message,
      secretsFilePath: options.candidateSecretsFilePath,
      assetsDirectory: options.assetsDirectoryOverride,
      previewAlias: alias,
    },
    { capture: true },
  );
  if (!isCleanCommandExit(upload)) {
    const cloudflareErrorCode = upload.errorCode;
    const isBootstrapError =
      isCompletedCommand(upload) &&
      (upload.failure === 'durable-migration' ||
        upload.failure === 'not-found' ||
        cloudflareErrorCode === DURABLE_MIGRATION_VERSION_ERROR ||
        cloudflareErrorCode === 10007);
    if (
      !options.preserveTriggers &&
      isBootstrapError &&
      (previous.versionId === null ||
        options.allowFirstDeploymentBootstrap === true ||
        (await previousIsSecretOnlyDraft()))
    ) {
      return bootstrapFirstDeployment(
        { ...options, message },
        previous.versionId,
        false,
        previousTriggerConfig,
      );
    }
    return {
      ok: false,
      reason: 'upload-failed',
      status: upload.status,
      ...commandDiagnosticFields(upload),
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(upload) ? { containersUnavailable: true } : {}),
    };
  }

  const uploaded = readUploadResult(upload);
  const versionId = uploaded?.versionId;
  if (!versionId) {
    return { ok: false, reason: 'upload-output-invalid' };
  }
  options.onProgress?.('Verifying the uploaded Worker...');
  if (inheritanceBaseline) {
    const recent = await readRecentCloudflareVersionIds(options);
    const previousLatest = inheritanceBaseline.at(-1);
    const expected = [...inheritanceBaseline.map((version) => version.id), versionId].slice(-10);
    if (recent === null) {
      return {
        ok: false,
        reason: 'inheritance-source-unavailable',
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    const uploadedVersion = recent.at(-1);
    if (
      !uploadedVersion ||
      uploadedVersion.id !== versionId ||
      uploadedVersion.number !== (previousLatest?.number ?? 0) + 1 ||
      !arraysEqual(
        recent.map((version) => version.id),
        expected,
      )
    ) {
      return {
        ok: false,
        reason: 'inheritance-source-changed',
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: uploadedVersion?.id ?? null,
        rollback: 'not-needed',
      };
    }
  }
  await options.validateUploadedVersion?.(versionId);
  if (options.recordVerifiedCandidate) {
    if (!options.validateUploadedVersion && !inheritanceBaseline) {
      throw new Error(
        'A Worker candidate cannot be recorded without validating its upload and version sequence.',
      );
    }
    await options.recordVerifiedCandidate(versionId, previous.versionId);
  }
  const reportedPreviewUrl =
    desiredTriggerConfig.preview_urls ||
    desiredTriggerConfig.preservePreviewUrls ||
    desiredTriggerConfig.preserve
      ? uploaded?.previewUrl
      : undefined;
  if (
    options.requirePreviewForReadiness &&
    (!reportedPreviewUrl ||
      !isCandidatePreviewUrl(reportedPreviewUrl, options.workerName, versionId, alias))
  ) {
    return {
      ok: false,
      reason: 'preview-unavailable',
      versionId,
      previousVersionId,
      rollback: 'not-needed',
      diagnostic:
        'This existing Worker has no version metadata binding and no genuine candidate preview URL. Keep its bindings unchanged; configure version metadata on the existing Worker or use an admitted version preview, then retry the handoff. Production traffic is unchanged.',
    };
  }
  let authenticatedWorkersDevSubdomain = reportedPreviewUrl
    ? extractWorkersDevSubdomain(reportedPreviewUrl)
    : undefined;
  let readinessUrl = reportedPreviewUrl;
  let readinessUsesCustomRoute = false;
  let stagedVersionOverride = false;
  if (!readinessUrl) {
    if (
      !options.preserveTriggers &&
      (previous.versionId === null ||
        options.allowFirstDeploymentBootstrap === true ||
        (await previousIsSecretOnlyDraft()))
    ) {
      return bootstrapFirstDeployment(
        { ...options, message },
        previous.versionId,
        false,
        previousTriggerConfig,
      );
    }
    readinessUrl = desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(options.workerName, options.workersDevSubdomain)
      : customRouteReadinessUrl(desiredTriggerConfig.routes);
    readinessUsesCustomRoute = !desiredTriggerConfig.workers_dev && readinessUrl !== undefined;
    if (!readinessUrl) {
      return {
        ok: false,
        reason: 'preview-unavailable',
        versionId,
        previousVersionId: previous.versionId,
      };
    }
    const fallbackSubdomain = extractWorkersDevSubdomain(readinessUrl);
    if (fallbackSubdomain && fallbackSubdomain === options.readinessHeadersWorkersDevSubdomain) {
      authenticatedWorkersDevSubdomain = fallbackSubdomain;
    }
    const stagingFailure = await stageCandidateForReadiness(
      options,
      previous.versionId,
      versionId,
      message,
    );
    if (stagingFailure) {
      return stagingFailure;
    }
    stagedVersionOverride = true;
  }

  const probe = (url: string) =>
    probeReadiness(
      `${url.replace(/\/$/, '')}/__void/ready`,
      options.workerName,
      readinessUsesCustomRoute ? undefined : options.readinessHeaders,
      authenticatedWorkersDevSubdomain,
      stagedVersionOverride ? versionId : undefined,
      options.fetch ?? globalThis.fetch,
      options.sleep ?? delay,
      options.readinessAttempts ?? 6,
      Number.POSITIVE_INFINITY,
      options.requireVersionMetadata ? versionId : undefined,
    );
  options.onProgress?.('Waiting for the Worker to become ready...');
  let ready = await probe(readinessUrl);

  // Account-wide Access default-deny commonly blocks Wrangler's generated preview alias even
  // when the stable `<worker>.<account>.workers.dev` destination has an application admitting the
  // operator or a service token. The preview response gives us the account subdomain, so preserve
  // the same no-traffic readiness invariant by staging the uploaded version at 0% and selecting it
  // explicitly through the stable, policy-covered hostname. This requires a prior active version
  // whose traffic can remain untouched while the new version is staged; a truly empty first
  // deployment has no safe zero-percent fallback.
  if (
    ready === 'access-denied' &&
    !stagedVersionOverride &&
    previous.versionId !== null &&
    !options.requirePreviewForReadiness
  ) {
    const stableReadinessUrl = desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(
          options.workerName,
          extractWorkersDevSubdomain(readinessUrl) ?? options.workersDevSubdomain,
        )
      : customRouteReadinessUrl(desiredTriggerConfig.routes);
    if (stableReadinessUrl && stableReadinessUrl !== readinessUrl) {
      const stagingFailure = await stageCandidateForReadiness(
        options,
        previous.versionId,
        versionId,
        message,
      );
      if (stagingFailure) {
        return stagingFailure;
      }
      readinessUrl = stableReadinessUrl;
      authenticatedWorkersDevSubdomain = extractWorkersDevSubdomain(stableReadinessUrl);
      readinessUsesCustomRoute = !desiredTriggerConfig.workers_dev;
      stagedVersionOverride = true;
      ready = await probe(readinessUrl);
    }
  }
  if (ready !== 'ready') {
    return {
      ok: false,
      reason: ready === 'access-denied' ? 'readiness-access-denied' : 'readiness-failed',
      versionId,
      previousVersionId: previous.versionId,
      ...(stagedVersionOverride
        ? await restorePreviousVersion(options, previous.versionId, 'readiness failed', [
            stagedVersionPercentages(previous.versionId, versionId),
          ])
        : { rollback: 'not-needed' as const }),
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      ...(stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            previous.versionId,
            'uploader verification failed',
            [stagedVersionPercentages(previous.versionId, versionId)],
          )
        : { rollback: 'not-needed' as const }),
    };
  }

  // Readiness can take long enough for another deploy or rollback to finish. Never flatten that
  // newer operation using the stale `previous` snapshot captured before this upload began.
  const ownerBeforeActivation = await readCurrentProductionVersion(options);
  if (ownerBeforeActivation.kind === 'failed') {
    return {
      ok: false,
      reason: 'status-failed',
      status: ownerBeforeActivation.status,
      versionId,
      previousVersionId: previous.versionId,
    };
  }
  if (ownerBeforeActivation.kind === 'split') {
    return {
      ok: false,
      reason: 'traffic-split-unsupported',
      versionId,
      previousVersionId: previous.versionId,
    };
  }
  const expectedTrafficBeforeActivation = stagedVersionOverride
    ? stagedVersionPercentages(previous.versionId, versionId)
    : previous.versionId
      ? [{ versionId: previous.versionId, percentage: 100 }]
      : [];
  if (
    ownerBeforeActivation.versionId !== previous.versionId ||
    !productionVersionPercentagesEqual(
      ownerBeforeActivation.versions,
      expectedTrafficBeforeActivation,
    )
  ) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId: previous.versionId,
      activeVersionId: ownerBeforeActivation.versionId,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    };
  }

  options.onProgress?.('Activating the Worker...');
  const activate = await deployVersionPercentages(options, [`${versionId}@100`], message);
  if (!isCleanCommandExit(activate)) {
    return {
      ok: false,
      reason: 'activation-failed',
      status: activate.status,
      versionId,
      previousVersionId: previous.versionId,
      ...(stagedVersionOverride
        ? await restorePreviousVersion(options, previous.versionId, 'version activation failed', [
            stagedVersionPercentages(previous.versionId, versionId),
            [{ versionId, percentage: 100 }],
          ])
        : { rollback: 'not-needed' as const }),
    };
  }

  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      // Never invoke a binary that just failed integrity verification, even to
      // restore traffic. The active version must be repaired with a trusted
      // Wrangler installation instead.
      rollback: previous.versionId ? 'unsafe' : 'unavailable',
    };
  }
  if (options.preserveTriggers) {
    const owner = await readCurrentProductionVersion(options);
    if (owner.kind !== 'ok' || owner.versionId !== versionId) {
      return {
        ok: false,
        reason: 'deployment-changed',
        versionId,
        previousVersionId: previous.versionId,
        ...(owner.kind === 'ok' ? { activeVersionId: owner.versionId } : {}),
        rollback: 'not-needed',
      };
    }
    return {
      ok: true,
      versionId,
      previousVersionId: previous.versionId,
      previewUrl: publishedCloudflareUrl(options.workerName, desiredTriggerConfig, readinessUrl),
      preservedTriggers: true,
      ...workersDevSubdomainResult(readinessUrl),
    };
  }
  const knownTriggerConfigs: Record<string, CloudflareTriggerConfig> = {
    [versionId]: desiredTriggerConfig,
  };
  if (previous.versionId && previousTriggerConfig) {
    knownTriggerConfigs[previous.versionId] = previousTriggerConfig;
  }
  options.onProgress?.('Updating routes and triggers...');
  const triggers = await stabilizeCloudflareVersionTriggers({
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    targetVersionId: versionId,
    targetTriggerConfig: desiredTriggerConfig,
    previousTriggerConfig,
    knownTriggerConfigs,
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
    publishEmptyCrons: options.publishEmptyCrons,
  });
  if (!triggers.ok) {
    if (triggers.activeVersionId && triggers.activeVersionId !== versionId) {
      return {
        ok: false,
        reason: 'deployment-changed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: triggers.activeVersionId,
        rollback: 'not-needed',
        triggerRepair: triggerRepairOutcome(triggers),
      };
    }
    if (!triggers.activeVersionId) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'unsafe',
      };
    }
    const ownerBeforeCompensation = await readCurrentProductionVersion(options);
    if (ownerBeforeCompensation.kind !== 'ok' || ownerBeforeCompensation.versionId === null) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'unsafe',
      };
    }
    if (ownerBeforeCompensation.versionId !== versionId) {
      const repair = await stabilizeCloudflareVersionTriggers({
        runWrangler: options.runWrangler,
        workerName: options.workerName,
        configPath: options.configPath,
        targetVersionId: versionId,
        targetTriggerConfig: desiredTriggerConfig,
        previousTriggerConfig,
        knownTriggerConfigs,
        publishEmptyCustomDomains: options.publishEmptyCustomDomains,
        publishEmptyCrons: options.publishEmptyCrons,
      });
      return {
        ok: false,
        reason: 'deployment-changed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: repair.activeVersionId ?? ownerBeforeCompensation.versionId,
        rollback: 'not-needed',
        triggerRepair: triggerRepairOutcome(repair),
      };
    }
    const restore = await restorePreviousVersionAndTriggers(
      options,
      previous.versionId,
      'trigger activation failed',
      desiredTriggerConfig,
      versionId,
      versionedPreviousTriggerConfigWithTraffic,
    );
    return {
      ok: false,
      reason: 'triggers-failed',
      status: triggers.status,
      versionId,
      previousVersionId: previous.versionId,
      ...restore,
    };
  }

  if (!triggers.targetOwnsTraffic) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId: previous.versionId,
      activeVersionId: triggers.activeVersionId,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    };
  }

  return {
    ok: true,
    versionId,
    previewUrl: publishedCloudflareUrl(options.workerName, desiredTriggerConfig, readinessUrl),
    previousVersionId: previous.versionId,
    ...(desiredTriggerConfig.preserve ? { preservedTriggers: true } : {}),
    ...(!desiredTriggerConfig.preserve
      ? {
          trafficConfig: {
            workers_dev: desiredTriggerConfig.workers_dev,
            preview_urls: desiredTriggerConfig.preview_urls,
            routes: desiredTriggerConfig.routes,
          },
        }
      : {}),
    ...workersDevSubdomainResult(readinessUrl),
  };
}

async function restorePreviousVersionAndTriggers(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    | 'configPath'
    | 'runWrangler'
    | 'verifyUploader'
    | 'workerName'
    | 'publishEmptyCustomDomains'
    | 'publishEmptyCrons'
  >,
  previousVersionId: string | null,
  cause: string,
  failedTriggerConfig: CloudflareTriggerConfig,
  failedVersionId: string,
  capturedTriggerConfig?: CloudflareTriggerConfig,
): Promise<PreviousVersionRestore> {
  const traffic = await restorePreviousVersion(options, previousVersionId, cause, [
    [{ versionId: failedVersionId, percentage: 100 }],
  ]);
  if (traffic.rollback !== 'succeeded' || !previousVersionId) {
    return traffic;
  }
  if (!options.verifyUploader()) {
    return { ...traffic, rollback: 'unsafe' };
  }
  // Traffic attachments can change between uploads (for example `void domain
  // add`). Restore the snapshot captured before this deployment, not the older
  // immutable version annotation. Cleanup-only queue names are deliberately not
  // part of this target snapshot.
  let targetTriggerConfig = capturedTriggerConfig;
  if (!targetTriggerConfig) {
    const metadata = await readCloudflareVersionMetadata(options, previousVersionId);
    if (metadata?.schema !== 2) {
      return { ...traffic, rollback: 'unavailable' };
    }
    targetTriggerConfig = metadata.triggerConfig;
  }
  // A preserve marker leaves routes, schedules, queue consumers and workflows opaque, so there
  // is no trigger snapshot to restore. Traffic is already back on the previous version.
  if (targetTriggerConfig.preserve) {
    return { ...traffic, rollback: 'unavailable' };
  }
  if (!options.verifyUploader()) {
    return { ...traffic, rollback: 'unsafe' };
  }
  const triggers = await stabilizeCloudflareVersionTriggers({
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    targetVersionId: previousVersionId,
    targetTriggerConfig,
    previousTriggerConfig: failedTriggerConfig,
    knownTriggerConfigs: { [previousVersionId]: targetTriggerConfig },
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
    publishEmptyCrons: options.publishEmptyCrons,
  });
  return {
    ...traffic,
    rollback: triggers.ok && triggers.targetOwnsTraffic ? 'succeeded' : 'failed',
  };
}

async function readCloudflareVersionMetadata(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
  versionId: string,
): Promise<CloudflareVersionMetadata | null> {
  return (await readCloudflareVersionInspection(options, versionId))?.metadata ?? null;
}

type CloudflareVersionInspection = Readonly<{
  metadata: CloudflareVersionMetadata | null;
  isSecretOnlyDraft: boolean;
  isVoidSecretOnlyDraft: boolean;
  voidDraftSecretNames: ReadonlyArray<string> | null;
}>;

async function readCloudflareVersionInspection(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
  versionId: string,
  knownVersions?: ReadonlyArray<unknown>,
): Promise<CloudflareVersionInspection | null> {
  try {
    // Version metadata is immutable. Reuse the pre-upload inheritance snapshot,
    // but keep ownership and the post-upload inheritance checks as fresh reads.
    let versions = knownVersions;
    if (versions === undefined) {
      const result = await options.runWrangler(
        { type: 'versions.list', configPath: options.configPath, workerName: options.workerName },
        { capture: true },
      );
      if (!isCleanCommandExit(result)) {
        return null;
      }
      versions = result.data as Array<unknown>;
    }
    if (!Array.isArray(versions)) {
      return null;
    }
    for (const entry of versions) {
      if (!isRecord(entry) || entry.id !== versionId) {
        continue;
      }
      const annotations = isRecord(entry.annotations) ? entry.annotations : undefined;
      const message = annotations?.['workers/message'];
      // The list endpoint omits resources. Inspect the exact active version before deciding
      // whether secret provisioning left a placeholder rather than an existing application.
      let draft = entry;
      if (
        annotations?.['workers/triggered_by'] === 'secret' &&
        Object.keys(annotations).length === 1 &&
        !isWranglerSecretOnlyDraft(entry)
      ) {
        const inspection = await options.runWrangler(
          {
            type: 'versions.view',
            versionId,
            configPath: options.configPath,
            workerName: options.workerName,
            includeSource: true,
          },
          { capture: true },
        );
        if (isCleanCommandExit(inspection)) {
          const inspected: unknown = inspection.data;
          if (isRecord(inspected) && inspected.id === versionId) {
            draft = inspected;
          }
        }
      }
      const isVoidDraft = isVoidSecretOnlyDraft(draft);
      return {
        metadata: typeof message === 'string' ? parseCloudflareVersionMessage(message) : null,
        isSecretOnlyDraft: isWranglerSecretOnlyDraft(draft) || isVoidDraft,
        isVoidSecretOnlyDraft: isVoidDraft,
        voidDraftSecretNames: isVoidDraft
          ? (draft.bindings as Array<{ name: string }>).map((binding) => binding.name)
          : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function readRecentCloudflareVersionIds(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
): Promise<Array<RecentCloudflareVersion> | null> {
  const result = await options.runWrangler(
    { type: 'versions.list', configPath: options.configPath, workerName: options.workerName },
    { capture: true },
  );
  if (!isCleanCommandExit(result)) {
    if (isWorkerNotFound(result)) {
      return [];
    }
    return null;
  }
  const versions = result.data;
  if (
    !Array.isArray(versions) ||
    !versions.every(
      (version) =>
        isRecord(version) &&
        typeof version.id === 'string' &&
        typeof version.number === 'number' &&
        Number.isSafeInteger(version.number),
    )
  ) {
    return null;
  }
  return versions.map((version) => ({
    id: version.id as string,
    number: version.number as number,
    inspection: version,
  }));
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function candidateReplacesAllRemoteSecrets(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'candidateSecrets' | 'configPath' | 'runWrangler' | 'workerName'
  >,
  activeVersionId: string | null,
  latestVersionId: string | null,
): Promise<boolean | null> {
  const versionIds = [
    ...new Set([activeVersionId, latestVersionId].filter(Boolean)),
  ] as Array<string>;
  const secretBindings: Array<Array<{ name: string; type: 'secret_key' | 'secret_text' }>> = [];
  for (const versionId of versionIds) {
    const bindings = await readCloudflareVersionSecretBindings(options, versionId);
    if (bindings === null) {
      return null;
    }
    secretBindings.push(bindings);
  }
  return secretBindings.every((bindings) =>
    bindings.every(
      (binding) =>
        binding.type === 'secret_text' &&
        Object.hasOwn(options.candidateSecrets ?? {}, binding.name),
    ),
  );
}

async function readCloudflareVersionSecretBindings(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
  versionId: string,
): Promise<Array<{ name: string; type: 'secret_key' | 'secret_text' }> | null> {
  const result = await options.runWrangler(
    {
      type: 'versions.view',
      versionId,
      configPath: options.configPath,
      workerName: options.workerName,
    },
    { capture: true },
  );
  if (!isCleanCommandExit(result)) {
    return null;
  }
  const version = result.data;
  if (!isRecord(version) || version.id !== versionId || !isRecord(version.resources)) {
    return null;
  }
  const bindings = version.resources.bindings;
  if (!Array.isArray(bindings) || !bindings.every(isRecord)) {
    return null;
  }
  const secrets: Array<{ name: string; type: 'secret_key' | 'secret_text' }> = [];
  for (const binding of bindings) {
    if (binding.type !== 'secret_text' && binding.type !== 'secret_key') {
      continue;
    }
    if (typeof binding.name !== 'string') {
      return null;
    }
    secrets.push({ name: binding.name, type: binding.type });
  }
  return secrets;
}

/**
 * The Versions API cannot create a Worker or its initial Durable Object migration history, and
 * some accounts do not expose a version preview until their first ordinary deployment. A
 * brand-new Worker can therefore need one ordinary deploy before later releases use preview-first
 * version activation. This fallback requires prior proof that no application had been deployed.
 */
async function bootstrapFirstDeployment(
  options: InternalCloudflareVersionActivationOptions,
  previousVersionId: string | null,
  atomic = false,
  previousTriggerConfig?: CloudflareTriggerConfig,
): Promise<CloudflareVersionActivation> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  {
    const current = await readCurrentProductionVersion(options);
    if (current.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: current.status };
    }
    if (
      current.kind !== 'ok' ||
      current.versionId !== previousVersionId ||
      !productionVersionPercentagesEqual(
        current.versions,
        previousVersionId ? [{ versionId: previousVersionId, percentage: 100 }] : [],
      )
    ) {
      return {
        ok: false,
        reason: 'deployment-changed',
        activeVersionId: current.kind === 'ok' ? current.versionId : null,
        rollback: 'not-needed',
      };
    }
  }
  options.onProgress?.(
    atomic ? 'Publishing the Worker atomically...' : 'Publishing the first Worker deployment...',
  );
  const bootstrap = await options.runWrangler(
    {
      type: 'worker.deploy',
      configPath: options.configPath,
      workerName: options.workerName,
      message: options.message,
      secretsFilePath: options.candidateSecretsFilePath,
      assetsDirectory: options.assetsDirectoryOverride,
    },
    { capture: true },
  );
  if (!isCleanCommandExit(bootstrap)) {
    const cloudflareErrorCode = bootstrap.errorCode;
    return {
      ok: false,
      reason: atomic ? 'atomic-failed' : 'bootstrap-failed',
      status: bootstrap.status,
      ...commandDiagnosticFields(bootstrap),
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(bootstrap) ? { containersUnavailable: true } : {}),
    };
  }
  const published = readUploadResult(bootstrap);
  const versionId = published?.versionId;
  const desiredMetadata = parseCloudflareVersionMessage(options.message);
  const desiredTriggerConfig = desiredTriggerConfigFor(desiredMetadata, options.configPath);
  const reportedUrl = published?.previewUrl ?? published?.workersDevUrl;
  const reportedOrConfiguredUrl =
    reportedUrl ??
    (desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(options.workerName, options.workersDevSubdomain)
      : customRouteReadinessUrl(desiredTriggerConfig.routes));
  if (!versionId || !reportedOrConfiguredUrl) {
    return {
      ok: false,
      reason: atomic ? 'atomic-output-invalid' : 'bootstrap-output-invalid',
      previousVersionId,
      ...(versionId ? { versionId } : {}),
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId,
      rollback: 'unsafe',
    };
  }
  const triggerOptions = {
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    targetVersionId: versionId,
    targetTriggerConfig: options.preserveTriggers
      ? { ...desiredTriggerConfig, preserve: true }
      : desiredTriggerConfig,
    previousTriggerConfig,
    ...(previousVersionId && previousTriggerConfig
      ? { knownTriggerConfigs: { [previousVersionId]: previousTriggerConfig } }
      : {}),
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
    publishEmptyCrons: options.publishEmptyCrons,
  };
  const verifyPublishedOwner = async (): Promise<CloudflareVersionActivation | null> => {
    const owner = await readCurrentProductionVersion(options);
    if (owner.kind === 'failed') {
      return {
        ok: false,
        reason: 'status-failed',
        status: owner.status,
        versionId,
        previousVersionId,
        rollback: 'unsafe',
      };
    }
    if (
      owner.kind !== 'ok' ||
      owner.versionId !== versionId ||
      !productionVersionPercentagesEqual(owner.versions, [{ versionId, percentage: 100 }])
    ) {
      // Another deployment may have published its code while this uploader was
      // still applying bootstrap settings. Repair only that owner's immutable
      // snapshot. If our code regains ownership, preserve all triggers until
      // its upload validation and checkpoint have completed.
      const repair =
        owner.kind === 'ok' &&
        owner.versionId &&
        owner.versionId !== versionId &&
        options.verifyUploader()
          ? await stabilizeCloudflareVersionTriggers({
              ...triggerOptions,
              targetTriggerConfig: { ...desiredTriggerConfig, preserve: true },
            })
          : null;
      return {
        ok: false,
        reason: 'deployment-changed',
        versionId,
        previousVersionId,
        activeVersionId: repair?.activeVersionId ?? (owner.kind === 'ok' ? owner.versionId : null),
        rollback: 'not-needed',
        ...(repair
          ? {
              triggerRepair:
                repair.ok && !repair.targetOwnsTraffic
                  ? 'succeeded'
                  : !repair.ok && repair.reason !== 'metadata-unavailable'
                    ? 'failed'
                    : 'unavailable',
            }
          : {}),
      };
    }
    return null;
  };
  const publishedOwnerFailure = await verifyPublishedOwner();
  if (publishedOwnerFailure) {
    return publishedOwnerFailure;
  }
  if (options.validateUploadedVersion || options.recordVerifiedCandidate) {
    options.onProgress?.('Verifying the uploaded Worker...');
    try {
      await options.validateUploadedVersion?.(versionId);
      const validatedOwnerFailure = await verifyPublishedOwner();
      if (validatedOwnerFailure) {
        return validatedOwnerFailure;
      }
      if (options.recordVerifiedCandidate) {
        if (
          !options.validateUploadedVersion &&
          !options.verifyInheritedSecrets &&
          options.expectedPreviousVersionId === undefined
        ) {
          throw new Error('The bootstrap upload has no verified candidate checkpoint.');
        }
        await options.recordVerifiedCandidate(versionId, previousVersionId);
      }
    } catch {
      return {
        ok: false,
        reason: atomic ? 'atomic-failed' : 'bootstrap-failed',
        versionId,
        previousVersionId,
        rollback: 'unavailable',
        diagnostic: `Worker version ${versionId} was published, but its upload validation or candidate checkpoint failed. Inspect the current Worker deployment before retrying.`,
      };
    }
    const checkpointOwnerFailure = await verifyPublishedOwner();
    if (checkpointOwnerFailure) {
      return checkpointOwnerFailure;
    }
  }
  // A version-aware atomic upload activates code without publishing routes.
  // Publish only the active owner's snapshot before probing a first Custom
  // Domain; enabling an unrequested workers.dev URL would expose the app.
  options.onProgress?.('Updating routes and triggers...');
  const triggers = await stabilizeCloudflareVersionTriggers(triggerOptions);
  if (!triggers.ok || !triggers.targetOwnsTraffic) {
    const superseded =
      triggers.activeVersionId !== undefined &&
      triggers.activeVersionId !== null &&
      triggers.activeVersionId !== versionId;
    return {
      ok: false,
      reason: superseded ? 'deployment-changed' : 'triggers-failed',
      ...(!triggers.ok ? { status: triggers.status } : {}),
      versionId,
      previousVersionId,
      activeVersionId: triggers.activeVersionId,
      rollback: superseded ? 'not-needed' : triggers.activeVersionId ? 'unavailable' : 'unsafe',
      ...(superseded
        ? {
            triggerRepair: triggerRepairOutcome(triggers),
          }
        : {}),
    };
  }
  const previewUrl = publishedCloudflareUrl(
    options.workerName,
    desiredTriggerConfig,
    reportedOrConfiguredUrl,
  );
  const usesCustomDomain =
    !desiredTriggerConfig.workers_dev &&
    desiredTriggerConfig.routes.some((route) => isRecord(route) && route.custom_domain === true);
  const customDomainBootstrap = !atomic && usesCustomDomain;
  const readinessTimeoutMs = customDomainBootstrap ? 300_000 : 60_000;
  options.onProgress?.('Waiting for the Worker to become ready...');
  const ready = await probeReadiness(
    `${previewUrl.replace(/\/$/, '')}/__void/ready`,
    options.workerName,
    extractWorkersDevSubdomain(previewUrl) ? options.readinessHeaders : undefined,
    extractWorkersDevSubdomain(previewUrl),
    undefined,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? delay,
    // A first Custom Domain needs DNS and certificate propagation. Existing
    // previews and explicitly atomic releases retain their shorter window.
    // Keep an overall deadline even when requests time out individually.
    options.readinessAttempts ?? (customDomainBootstrap ? 150 : 30),
    readinessTimeoutMs,
    options.requireVersionMetadata ? versionId : undefined,
  );
  if (ready !== 'ready') {
    return {
      ok: false,
      reason:
        ready === 'access-denied'
          ? atomic
            ? 'atomic-readiness-access-denied'
            : 'bootstrap-readiness-access-denied'
          : atomic
            ? 'atomic-readiness-failed'
            : 'bootstrap-readiness-failed',
      versionId,
      previousVersionId,
      rollback: 'unavailable',
      ...(ready === 'failed' && usesCustomDomain
        ? {
            diagnostic:
              'The Custom Domain may still be propagating DNS or its TLS certificate. Check the configured domain in Cloudflare, then retry `void deploy --platform cloudflare` once its /__void/ready endpoint is reachable.',
          }
        : {}),
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId,
      rollback: 'unsafe',
    };
  }
  // DNS propagation can outlast another deploy. A successful response alone
  // must not record this version as live after a newer owner took over.
  const ownerAfterReadiness = await readCurrentProductionVersion(options);
  if (ownerAfterReadiness.kind === 'failed') {
    return {
      ok: false,
      reason: 'status-failed',
      status: ownerAfterReadiness.status,
      versionId,
      previousVersionId,
      rollback: 'unsafe',
    };
  }
  if (ownerAfterReadiness.kind !== 'ok' || ownerAfterReadiness.versionId !== versionId) {
    const repair = await stabilizeCloudflareVersionTriggers(triggerOptions);
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId,
      activeVersionId: repair.activeVersionId,
      rollback: 'not-needed',
      triggerRepair: triggerRepairOutcome(repair),
    };
  }
  return {
    ok: true,
    versionId,
    previewUrl,
    previousVersionId,
    ...(atomic
      ? {
          trafficConfig: {
            workers_dev: desiredTriggerConfig.workers_dev,
            preview_urls: desiredTriggerConfig.preview_urls,
            routes: desiredTriggerConfig.routes,
          },
        }
      : {}),
    ...workersDevSubdomainResult(previewUrl),
  };
}

function readUploadResult(result: CloudflareCommandResult): CloudflareUploadResult | null {
  const data = result.data;
  if (
    !isRecord(data) ||
    typeof data.versionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(data.versionId)
  ) {
    return null;
  }
  if (
    (data.previewUrl !== undefined && typeof data.previewUrl !== 'string') ||
    (data.workersDevUrl !== undefined && typeof data.workersDevUrl !== 'string')
  ) {
    return null;
  }
  return data as CloudflareUploadResult;
}

function versionPercentages(
  values: Array<string>,
): Array<{ versionId: string; percentage: number }> {
  return values.map((value) => {
    const [versionId, percentage] = value.split('@');
    return { versionId: versionId!, percentage: Number(percentage) };
  });
}

function commandDiagnosticFields(result: CloudflareCommandResult): { diagnostic?: string } {
  const diagnostic = cloudflareCommandDiagnostic(result);
  return diagnostic ? { diagnostic } : {};
}

function isContainersUnavailable(result: CloudflareCommandResult): boolean {
  return (
    result.failure === 'containers-unavailable' ||
    (result.errors?.some(
      ({ message }) =>
        /Cloudflare Containers[^\n]*(?:Workers Paid|not (?:enabled|available)|subscription)/i.test(
          message,
        ) ||
        (/\/containers\/me(?:\b|\?)/i.test(message) && /\b403\b/.test(message)),
    ) ??
      false)
  );
}

async function readCurrentProductionVersion(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
): Promise<CurrentProductionVersion> {
  const result = await options.runWrangler(
    { type: 'deployments.status', configPath: options.configPath, workerName: options.workerName },
    { capture: true },
  );
  if (!isCleanCommandExit(result)) {
    if (isWorkerNotFound(result)) {
      return { kind: 'ok', versionId: null, versions: [] };
    }
    return { kind: 'failed', status: result.status };
  }
  try {
    const deployment = result.data as ProductionDeployment;
    const versions = (deployment.versions ?? []).map((version) => ({
      versionId: typeof version.version_id === 'string' ? version.version_id : '',
      percentage: Number(version.percentage),
    }));
    if (
      versions.some(
        (version) =>
          version.versionId.length === 0 ||
          !Number.isFinite(version.percentage) ||
          version.percentage < 0 ||
          version.percentage > 100,
      )
    ) {
      return { kind: 'failed', status: result.status };
    }
    const activeVersions = versions.filter((version) => version.percentage > 0);
    if (
      activeVersions.length > 1 ||
      (activeVersions.length === 1 && activeVersions[0]?.percentage !== 100)
    ) {
      return { kind: 'split' };
    }
    const active = activeVersions[0];
    return {
      kind: 'ok',
      versionId: active?.versionId ?? null,
      versions,
    };
  } catch {
    return { kind: 'failed', status: result.status };
  }
}

function productionVersionPercentagesEqual(
  actual: ReadonlyArray<ProductionVersionPercentage>,
  expected: ReadonlyArray<ProductionVersionPercentage>,
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((entry) =>
      actual.some(
        (candidate) =>
          candidate.versionId === entry.versionId && candidate.percentage === entry.percentage,
      ),
    )
  );
}

function stagedVersionPercentages(
  previousVersionId: string | null,
  versionId: string,
): Array<ProductionVersionPercentage> {
  return previousVersionId
    ? [
        { versionId: previousVersionId, percentage: 100 },
        { versionId, percentage: 0 },
      ]
    : [];
}

/** Stage the candidate at 0% beside the unchanged previous version so readiness can select it. */
async function stageCandidateForReadiness(
  options: CloudflareVersionActivationOptions,
  previousVersionId: string | null,
  versionId: string,
  message: string,
): Promise<Extract<CloudflareVersionActivation, { ok: false }> | null> {
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  const ownerFailure = await verifyReadinessStagingOwner(options, previousVersionId, versionId);
  if (ownerFailure) {
    return ownerFailure;
  }
  const staged = await deployVersionPercentages(
    options,
    [`${previousVersionId}@100`, `${versionId}@0`],
    message,
  );
  if (!isCleanCommandExit(staged)) {
    const cloudflareErrorCode = staged.errorCode;
    return {
      ok: false,
      reason: 'readiness-staging-failed',
      status: staged.status,
      ...commandDiagnosticFields(staged),
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  return null;
}

async function verifyReadinessStagingOwner(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'workerName'
  >,
  previousVersionId: string | null,
  versionId: string,
): Promise<Extract<CloudflareVersionActivation, { ok: false }> | null> {
  const owner = await readCurrentProductionVersion(options);
  if (owner.kind === 'failed') {
    return {
      ok: false,
      reason: 'status-failed',
      status: owner.status,
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  if (owner.kind === 'split') {
    return {
      ok: false,
      reason: 'traffic-split-unsupported',
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  const expected = previousVersionId ? [{ versionId: previousVersionId, percentage: 100 }] : [];
  if (
    owner.versionId !== previousVersionId ||
    !productionVersionPercentagesEqual(owner.versions, expected)
  ) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId,
      activeVersionId: owner.versionId,
      rollback: 'not-needed',
    };
  }
  return null;
}

async function probeReadiness(
  url: string,
  workerName: string,
  readinessHeaders: Readonly<Record<string, string>> | undefined,
  authenticatedWorkersDevSubdomain: string | undefined,
  versionOverride: string | undefined,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
  timeoutMs = Number.POSITIVE_INFINITY,
  expectedVersionId?: string,
): Promise<'ready' | 'failed' | 'access-denied'> {
  const headers = guardedReadinessHeaders(
    url,
    workerName,
    readinessHeaders,
    authenticatedWorkersDevSubdomain,
  );
  if (headers === null) {
    return 'failed';
  }
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    let response: Response | undefined;
    try {
      response = await fetcher(url, {
        headers: {
          'user-agent': 'void-deploy-readiness/1',
          ...headers,
          ...(versionOverride
            ? {
                'Cloudflare-Workers-Version-Overrides': `${workerName}="${versionOverride}"`,
              }
            : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
      });
      if (response.ok) {
        const body = (await response.json()) as { ready?: unknown; versionId?: unknown };
        if (
          body.ready === true &&
          (expectedVersionId === undefined || body.versionId === expectedVersionId)
        ) {
          return 'ready';
        }
      } else if (await isCloudflareAccessDenial(response)) {
        return 'access-denied';
      }
    } catch {
      // Preview propagation is eventually consistent; retry below.
    } finally {
      if (response && !response.bodyUsed) {
        await response.body?.cancel().catch(() => {});
      }
    }
    if (attempt + 1 < attempts) {
      const waitMs = Math.min(250 * 2 ** attempt, 2_000, deadline - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  return 'failed';
}

/** Never forward Access headers to a hostname that cannot be this Worker. */
function guardedReadinessHeaders(
  url: string,
  workerName: string,
  headers: Readonly<Record<string, string>> | undefined,
  authenticatedWorkersDevSubdomain: string | undefined,
): Readonly<Record<string, string>> | null {
  if (!headers || Object.keys(headers).length === 0) {
    return {};
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const firstLabel = hostname.split('.')[0] ?? '';
    const normalizedWorkerName = workerName.toLowerCase();
    const subdomain = extractWorkersDevSubdomain(url);
    if (
      parsed.protocol !== 'https:' ||
      !subdomain ||
      subdomain !== authenticatedWorkersDevSubdomain ||
      (firstLabel !== normalizedWorkerName && !firstLabel.endsWith(`-${normalizedWorkerName}`))
    ) {
      return null;
    }
    return headers;
  } catch {
    return null;
  }
}

async function isCloudflareAccessDenial(response: Response): Promise<boolean> {
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get('location')?.includes('/cdn-cgi/access/')
  ) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    return true;
  }
  try {
    return /(?:error\s+code:\s*)?1050\b/i.test(await response.text());
  } catch {
    return false;
  }
}

async function deployVersionPercentages(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'workerName' | 'preserveTriggers' | 'configPath'
  > & { bypassDeploymentChecks?: boolean },
  percentages: Array<string>,
  message: string,
): Promise<CloudflareCommandResult> {
  const metadata = parseCloudflareVersionMessage(message);
  if (
    (options.preserveTriggers || (metadata?.schema === 2 && metadata.triggerConfig.preserve)) &&
    options.configPath
  ) {
    return deployCloudflareVersionTraffic({
      ...options,
      configPath: options.configPath,
      percentages,
      message,
    });
  }
  return options.runWrangler(
    {
      type: 'versions.deploy',
      versions: versionPercentages(percentages),
      configPath: options.configPath,
      workerName: options.workerName,
      message,
      ...(options.bypassDeploymentChecks ? { bypassDeploymentChecks: true } : {}),
    },
    { capture: false },
  );
}

/** Change version traffic without synchronizing Worker settings from local config. */
export async function deployCloudflareVersionTraffic(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  percentages: Array<string>;
  message: string;
  bypassDeploymentChecks?: boolean;
}): Promise<CloudflareCommandResult> {
  const config = pickWranglerTriggerContext(parseRootWranglerConfig(options.configPath));
  const directory = mkdtempSync(join(tmpdir(), 'void-version-traffic-'));
  const path = join(directory, 'wrangler.json');
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    return await options.runWrangler(
      {
        type: 'versions.deploy',
        versions: versionPercentages(options.percentages),
        configPath: path,
        workerName: options.workerName,
        message: options.message,
        ...(options.bypassDeploymentChecks ? { bypassDeploymentChecks: true } : {}),
      },
      { capture: false },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type PreviousVersionRestore = Readonly<{
  rollback: 'succeeded' | 'failed' | 'unavailable' | 'unsafe';
  restoredOlderSecrets?: true;
}>;

async function restorePreviousVersion(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  previousVersionId: string | null,
  cause: string,
  expectedOwnedTraffic: ReadonlyArray<ReadonlyArray<ProductionVersionPercentage>>,
): Promise<PreviousVersionRestore> {
  if (!previousVersionId) {
    return { rollback: 'unavailable' };
  }
  if (!options.verifyUploader()) {
    return { rollback: 'unsafe' };
  }
  const ownsExpectedTraffic = async () => {
    const owner = await readCurrentProductionVersion(options);
    return (
      owner.kind === 'ok' &&
      expectedOwnedTraffic.some((expected) =>
        productionVersionPercentagesEqual(owner.versions, expected),
      )
    );
  };
  if (!(await ownsExpectedTraffic())) {
    return { rollback: 'unsafe' };
  }
  const restore = (bypassDeploymentChecks: boolean) =>
    deployVersionPercentages(
      { ...options, bypassDeploymentChecks },
      [`${previousVersionId}@100`],
      `Void automatic rollback after ${cause}.`,
    );
  const result = await restore(false);
  // Cloudflare refuses to move traffic back to a version older than a secret
  // change (10220). When the failed version made that change, force the
  // restore, as Wrangler's rollback does. Check again first that Void still
  // owns traffic, so a deployment made by someone else is not overwritten.
  if (result.errorCode === CLOUDFLARE_SECRET_CHANGED_ERROR) {
    if (!(await ownsExpectedTraffic())) {
      return { rollback: 'unsafe' };
    }
    return isCleanCommandExit(await restore(true))
      ? { rollback: 'succeeded', restoredOlderSecrets: true }
      : { rollback: 'failed' };
  }
  return { rollback: isCleanCommandExit(result) ? 'succeeded' : 'failed' };
}

function workersDevReadinessUrl(workerName: string, value: string | undefined): string | undefined {
  const subdomain = normalizeWorkersDevSubdomain(value);
  if (!subdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    return undefined;
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/** Resolve the stable URL that owns production traffic after triggers are published. */
function publishedCloudflareUrl(
  workerName: string,
  triggerConfig: CloudflareTriggerConfig,
  fallbackUrl: string,
): string {
  if (triggerConfig.workers_dev) {
    return (
      workersDevReadinessUrl(workerName, extractWorkersDevSubdomain(fallbackUrl)) ?? fallbackUrl
    );
  }
  return customRouteReadinessUrl(triggerConfig.routes) ?? fallbackUrl;
}

/** Normalize an account workers.dev subdomain supplied by config or the environment. */
export function normalizeWorkersDevSubdomain(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/\.workers\.dev\/?$/, '');
  if (!normalized || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.fed)?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/** Extract the account subdomain from a Wrangler-reported workers.dev URL. */
export function extractWorkersDevSubdomain(url: string): string | undefined {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.');
    if (labels.at(-2) !== 'workers' || labels.at(-1) !== 'dev') {
      return undefined;
    }
    if (labels.length === 4) {
      return normalizeWorkersDevSubdomain(labels[1]);
    }
    if (labels.length === 5 && labels[2] === 'fed') {
      return normalizeWorkersDevSubdomain(`${labels[1]}.fed`);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function workersDevSubdomainResult(url: string): { workersDevSubdomain?: string } {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  return workersDevSubdomain ? { workersDevSubdomain } : {};
}
