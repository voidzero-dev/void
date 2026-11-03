import { readFileSync } from 'node:fs';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  readWranglerTopLevelString,
} from '@void/deploy-cloudflare';
import { basename, join } from 'pathslash';
import { type ApplicationAnalysis } from '../application-analysis.ts';
import { analyzeApplication, completeApplicationAnalysis } from '../application-routing.ts';
import { MATERIALIZED_CLOUDFLARE_FILE } from '../cloudflare-config.ts';
import { type DatabaseDialect, type VoidConfig } from '../config.ts';
import { collectRevalidate, hasRevalidate } from '../isr-config.ts';
import { scopedCloudflareQueueName } from '../queues/cloudflare-names.ts';
import { hasEmailHandlers, type EmailHandlersScan } from '../router/email.ts';
import { DEFAULT_VOID_AI_BINDING } from './deploy-binding-snapshot.ts';
import { type CloudflareAuthSecretFailureReason } from './deploy-types.ts';
import {
  isRealD1Id,
  isRealKvId,
  type DesiredResourceSet,
  type ProvisionDriftEntry,
} from './provision.ts';

/** Human labels for a drifted resource kind, used in guidance messages. */
export const CLOUDFLARE_RESOURCE_LABELS: Record<ProvisionDriftEntry['kind'], string> = {
  d1: 'D1 database',
  kv: 'KV namespace',
  r2: 'R2 bucket',
  hyperdrive: 'Hyperdrive config',
};

export const BETTER_AUTH_SECRET_NAME = 'BETTER_AUTH_SECRET';

/** Values-free failure from the Cloudflare Better Auth secret lifecycle. */
export class CloudflareAuthSecretError extends Error {
  override name = 'CloudflareAuthSecretError';
  readonly reason: CloudflareAuthSecretFailureReason;

  constructor(message: string, reason: CloudflareAuthSecretFailureReason) {
    super(message);
    this.reason = reason;
  }
}

const CLOUDFLARE_WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';

const CLOUDFLARE_CONTAINERS_PRICING_URL = 'https://developers.cloudflare.com/containers/pricing/';

/**
 * Guidance for a failed Containers check. Cloudflare reports a missing Workers Paid plan and a
 * token without Containers permission the same way, so the message gives both remedies.
 */
export function formatCloudflareSandboxUnavailable(options?: { preflight?: boolean }): string {
  return [
    options?.preflight
      ? 'deploy: this app uses `void/sandbox`, but Void could not verify Cloudflare Containers with the current account and credentials.'
      : "deploy: Cloudflare rejected access to Containers while deploying this app's Sandbox.",
    'Cloudflare Containers require the Workers Paid plan and are not available on Workers Free.',
    '',
    `Enable Workers Paid: ${CLOUDFLARE_WORKERS_PAID_URL}`,
    `Containers pricing: ${CLOUDFLARE_CONTAINERS_PRICING_URL}`,
    '',
    'If this account already has Workers Paid:',
    '  • Run `void cloudflare login` again; or',
    '  • Give CLOUDFLARE_API_TOKEN Account / Containers: Edit and Account / Cloudchamber: Edit.',
    '',
    'Rerun the deploy; Void will verify Containers access automatically.',
    options?.preflight
      ? 'No resources were provisioned and the app was not built or deployed.'
      : 'The Sandbox container was not deployed.',
  ].join('\n');
}

/** The length cap {@link toValidWorkerName} applies (the CF plugin's own rule). */
const MAX_WORKER_NAME_LENGTH = 63;

/**
 * Same rule as `@cloudflare/vite-plugin`'s `toValidWorkerName`, so the name pinned in the
 * config matches the name the build emits.
 */
function toValidWorkerName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKER_NAME_LENGTH)
    .replace(/-+$/g, '');
  return name.length > 0 ? name : 'my-worker';
}

/**
 * `<worker>-<suffix>` within the length cap. A long worker name is trimmed instead of the
 * suffix, so `KV` and `ISR_CACHE` never derive the same namespace title.
 */
function suffixedResourceName(workerName: string, suffix: string): string {
  const full = toValidWorkerName(`${workerName}-${suffix}`);
  if (full.endsWith(`-${suffix}`)) {
    return full;
  }
  const base = toValidWorkerName(workerName)
    .slice(0, MAX_WORKER_NAME_LENGTH - suffix.length - 1)
    .replace(/-+$/g, '');
  return toValidWorkerName(`${base}-${suffix}`);
}

/**
 * Worker name as the CF plugin derives it (package.json `name`, then the directory name),
 * ignoring `WRANGLER_CI_OVERRIDE_NAME`: deploy scrubs that override from the build.
 */
export function deriveWorkerName(root: string): string {
  let pkgName: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      pkgName = pkg.name;
    }
  } catch {
    // no package.json / unreadable — fall through to the directory basename.
  }
  return toValidWorkerName(pkgName ?? basename(root) ?? '');
}

/**
 * Fail when two KV bindings would share one namespace. KV titles are not account-unique and
 * the provisioner adopts a namespace by title, so check desired titles and recorded ids.
 */
function assertDistinctKvNamespaces(
  kvNamespaces: Array<{ binding: string; title: string }>,
  config: Record<string, unknown>,
  configPath: string,
): void {
  const bindingByTitle = new Map<string, string>();
  for (const { binding, title } of kvNamespaces) {
    const owner = bindingByTitle.get(title);
    if (owner !== undefined) {
      throw new Error(
        `deploy: KV bindings ${JSON.stringify(owner)} and ${JSON.stringify(binding)} both resolve ` +
          `to the namespace title ${JSON.stringify(title)}. KV titles are not account-unique, so ` +
          `provisioning would put both bindings on ONE namespace. Give the worker a shorter ` +
          `"name" in "${configPath}" so each binding derives its own title, then retry.`,
      );
    }
    bindingByTitle.set(title, binding);
  }

  const managed = new Set(kvNamespaces.map((kv) => kv.binding));
  const entries = config.kv_namespaces;
  if (!Array.isArray(entries)) {
    return;
  }
  const bindingById = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { binding, id } = entry as { binding?: unknown; id?: unknown };
    if (typeof binding !== 'string' || !managed.has(binding) || !isRealKvId(id)) {
      continue;
    }
    const owner = bindingById.get(id);
    if (owner !== undefined && owner !== binding) {
      throw new Error(
        `deploy: KV bindings ${JSON.stringify(owner)} and ${JSON.stringify(binding)} in ` +
          `"${configPath}" both point at KV namespace id ${JSON.stringify(id)}. They resolved to a ` +
          `single namespace when they were provisioned, so the two bindings share one namespace ` +
          `and one quota slot. Give one of them a fresh namespace (create it, or drop its entry ` +
          `from "${configPath}" and rerun the deploy), then retry.`,
      );
    }
    bindingById.set(id, binding);
  }
}

/**
 * Desired Cloudflare resources, computed from source before the build and shared by the
 * provision and drift paths. Names prefer the value stored in the root config, so a
 * re-provision reuses the same resource. `reasons` explains each binding in drift messages.
 */
export async function computeDesiredCloudflareResources(
  root: string,
  voidConfig: VoidConfig,
  configPath: string,
  application?: ApplicationAnalysis,
): Promise<{
  desired: DesiredResourceSet;
  reasons: Map<string, string>;
  authEnabled: boolean;
  /** sqlite uses D1; postgresql and mysql use Hyperdrive. */
  dialect: DatabaseDialect;
  /** Absolute migrations directory (sourceDir-aware). */
  migrationsDir: string;
  migrations: Array<{ name: string; sql: string }>;
  /** Source uses Workers AI, which authorizes the emitted AI binding. */
  needsAI: boolean;
  /** Workers AI binding emitted by the build (default `AI`). */
  aiBindingName: string;
  /** `void.config.ts` enables Sandbox or the source imports `void/sandbox`. */
  needsSandbox: boolean;
  /** Whether the source imports void/live and the build may emit its Durable Object. */
  needsLive: boolean;
  analysis: ApplicationAnalysis;
  /** Cron schedules the build emits into `triggers.crons`. */
  expectedCrons: Array<string>;
  /** Inbound `email/` handlers or an outbound `void/email` import. */
  needsEmail: boolean;
  emailHandlers: EmailHandlersScan;
}> {
  const analysis = application
    ? await completeApplicationAnalysis(application)
    : await analyzeApplication(root, { config: voidConfig, environment: 'prod' });
  const { paths, bindings, authEnabled, dialect, bindingNames, migrations, needsDatabase } =
    analysis;
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name') ?? deriveWorkerName(root);

  // `migrations_dir` is relative to the root config, and sourceDir moves the folder.
  const migrationsDirRelative = paths.sourceDir
    ? `./${paths.sourceDir}/db/migrations`
    : './db/migrations';

  const desired: DesiredResourceSet = { kvNamespaces: [], queues: [] };
  const reasons = new Map<string, string>();

  // needsDatabase covers source use, auth and checked-in migrations, like the managed manifest.
  const databaseReason = analysis.reasons.database[0]!;
  if (needsDatabase && dialect === 'sqlite') {
    const binding = bindingNames?.d1 ?? 'DB';
    // An explicitly authored name is the intended remote identity even before Void
    // has pinned its ID. Only inferred local placeholders need a generated name.
    const storedName = readStoredResourceName(config, 'd1_databases', binding, 'database_name');
    const storedId = readStoredResourceName(config, 'd1_databases', binding, 'database_id');
    const authoredName = voidConfig.cloudflare?.d1_databases?.find(
      (entry) => entry.binding === binding,
    )?.database_name;
    const name =
      storedName != null && isRealD1Id(storedId)
        ? storedName
        : authoredName?.trim() ||
          (basename(configPath) !== MATERIALIZED_CLOUDFLARE_FILE && storedName !== 'default'
            ? storedName
            : undefined) ||
          suffixedResourceName(workerName, 'db');
    desired.d1 = { binding, name, migrationsDir: migrationsDirRelative };
    reasons.set(binding, databaseReason);
  }

  // KV
  if (bindings.needsKV) {
    const binding = bindingNames?.kv ?? 'KV';
    desired.kvNamespaces.push({ binding, title: suffixedResourceName(workerName, 'kv') });
    reasons.set(binding, analysis.reasons.kv[0]!);
  }

  // R2
  if (bindings.needsR2) {
    const binding = bindingNames?.r2 ?? 'STORAGE';
    const storedName = readStoredResourceName(config, 'r2_buckets', binding, 'bucket_name');
    // Only a generated binding in a typed project uses `default` as a local
    // placeholder. In an authored root config, or an explicit typed Cloudflare
    // binding, it is a valid bucket name and must keep its identity.
    const generatedDefault =
      storedName === 'default' &&
      basename(configPath) === MATERIALIZED_CLOUDFLARE_FILE &&
      !voidConfig.cloudflare?.r2_buckets?.some(
        (entry) => entry.binding === binding && entry.bucket_name === 'default',
      );
    const bucketName =
      storedName && !generatedDefault ? storedName : suffixedResourceName(workerName, 'storage');
    desired.r2 = { binding, bucketName };
    reasons.set(binding, analysis.reasons.r2[0]!);
  }

  // Queue names are account-unique, so each is named after the Worker. Preflight keeps a
  // queue this Worker already consumes under its old name.
  if (analysis.queues.length > 0) {
    desired.queueNames = Object.fromEntries(
      analysis.queues.map((q) => [
        q.name,
        scopedCloudflareQueueName(toValidWorkerName(workerName), q.name),
      ]),
    );
    desired.queues = Object.values(desired.queueNames);
  }

  // The connection string is used only on create; later runs read the stored id.
  if (needsDatabase && dialect !== 'sqlite') {
    const binding = 'HYPERDRIVE';
    desired.hyperdrive = {
      binding,
      name: suffixedResourceName(workerName, 'hyperdrive'),
      connectionString: process.env.DATABASE_URL ?? '',
    };
    reasons.set(
      binding,
      `app uses ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} (needs a Hyperdrive config)`,
    );
  }

  // ISR_CACHE is not in the import walk; this matches the build's `emitIsr` gate.
  const pageScan = analysis.scan.pages;
  if (hasRevalidate(collectRevalidate(voidConfig, pageScan))) {
    const binding = 'ISR_CACHE';
    desired.kvNamespaces.push({ binding, title: suffixedResourceName(workerName, 'isr-cache') });
    reasons.set(binding, 'routes use `revalidate` (ISR) — needs an ISR_CACHE KV namespace');
  }

  assertDistinctKvNamespaces(desired.kvNamespaces, config, configPath);

  const expectedCrons = [...new Set(analysis.jobs.flatMap((job) => job.crons))];
  const emailHandlers = analysis.email;

  return {
    analysis,
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir: paths.migrationsDir,
    migrations,
    needsAI: bindings.needsAI,
    aiBindingName: bindingNames?.ai ?? DEFAULT_VOID_AI_BINDING,
    expectedCrons,
    needsEmail: bindings.needsEmail === true || hasEmailHandlers(emailHandlers),
    emailHandlers,
    needsSandbox: bindings.needsSandbox,
    needsLive: bindings.needsLive === true,
  };
}
