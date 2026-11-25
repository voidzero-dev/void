import {
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
} from '@void/platform';
import type { InstallationResource, PlatformInstallationManifest } from '@void/platform';
import { PlatformCloudflareApiError } from './platform-cloudflare.ts';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import { platformTrafficAttachmentWorker } from './platform-traffic.ts';
import { readPlatformDatabase } from './platform-zero-trust-uninstall.ts';

/**
 * `void platform uninstall --purge-resources` deletes every Cloudflare resource the
 * installation created, in an order Cloudflare accepts:
 *
 *   traffic (routes, custom domains, DNS) -> Access -> Email Routing rules
 *   -> queue consumers -> Workers except tail -> Queues -> dispatch namespace
 *   -> tail Worker -> Hyperdrive and KV -> R2 -> AI Gateway -> routing KV (last)
 *
 * Each resource is proven to belong to this installation right before its
 * DELETE, and Cloudflare refuses a resource that something outside the
 * installation still uses. The only forced DELETE is for a platform Worker
 * that Cloudflare refused while every Worker it names as a dependent is one
 * this installation created: the API and proxy Workers bind to each other, so
 * neither can go first without it. A route, custom domain, DNS
 * record, or Access resource that no longer matches what was recorded is kept
 * and listed with the reason instead of stopping the run. Every finished
 * deletion is checkpointed, so rerunning the command continues where it
 * stopped. The routing KV namespace holds that checkpoint, so uninstall
 * deletes it last.
 *
 * An uninstall without --purge-resources records what it leaves as retained. If it
 * stopped before it finished, --purge-resources considers those resources again.
 */

export const PURGE_RESOURCES_STEP_PREFIX = 'uninstall:purge-resources:';

export type PurgeResourcesClient = Pick<
  PlatformCloudflareClient,
  | 'deleteAccessResource'
  | 'deleteDispatchNamespaceScript'
  | 'deleteEmailRoutingRule'
  | 'deleteQueueConsumer'
  | 'deleteR2Object'
  | 'deleteResource'
  | 'deleteWorkerDomain'
  | 'deleteWorkerRoute'
  | 'emptyR2Bucket'
  | 'forceDeleteWorker'
  | 'getAccessResource'
  | 'getEmailRoutingCatchAll'
  | 'listAiGateways'
  | 'listDispatchNamespaceScripts'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listEmailRoutingRules'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueueConsumers'
  | 'listR2Buckets'
  | 'listWorkerDependents'
  | 'listWorkerDomains'
  | 'listWorkerNames'
  | 'listWorkerRoutes'
  | 'resetEmailRoutingCatchAll'
>;

export type PurgeResourcesCredential = Readonly<{
  source: 'environment' | 'saved' | 'oauth';
  /** The runtime token is available for AI Gateway calls. */
  aiGatewayToken: boolean;
}>;

type AccessResource = NonNullable<PlatformInstallationManifest['authenticationResources']>[number];

type Target =
  | Readonly<{ phase: 'traffic'; resource: InstallationResource; worker: InstallationResource }>
  | Readonly<{
      phase:
        | 'dns'
        // The resource is the email gateway Worker the rules send mail to.
        | 'email'
        | 'queue-consumers'
        | 'workers'
        | 'queues'
        | 'dispatch'
        | 'tail'
        | 'data'
        | 'r2'
        | 'ai-gateway'
        | 'routing';
      resource: InstallationResource;
    }>
  | Readonly<{ phase: 'access'; access: AccessResource }>;

// Workers deleted in this order before the tail Worker. Cloudflare accepted it
// without force; anything else that sends logs to the tail Worker goes first.
const WORKER_ORDER = ['email-gateway-worker', 'proxy-worker', 'dispatch-worker', 'api-worker'];

const PERMISSIONS = {
  access: 'Account → Access: Apps and Policies → Edit',
  aiGateway: 'Account → AI Gateway → Edit',
  dns: 'Zone → DNS → Edit',
  emailRouting: 'Zone → Email Routing Rules → Edit',
  hyperdrive: 'Account → Hyperdrive → Edit',
  kv: 'Account → Workers KV Storage → Edit',
  queues: 'Account → Queues → Edit',
  r2: 'Account → Workers R2 Storage → Edit',
  routes: 'Zone → Workers Routes → Edit',
  serviceTokens: 'Account → Access: Service Tokens → Edit',
  workers: 'Account → Workers Scripts → Edit',
} as const;

export function isPlatformTailWorker(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  return (
    resource.kind === 'worker' &&
    (resource.key === 'tail-worker' || resource.name === manifest.deployment.resources.tailWorker)
  );
}

export function purgeResourcesResumeCommand(manifest: PlatformInstallationManifest): string {
  return `void platform uninstall ${manifest.id} --purge-resources`;
}

function accessStepKey(access: AccessResource): string {
  return `${PURGE_RESOURCES_STEP_PREFIX}access:${access.key}`;
}

/** Access resources that --purge-resources already deleted. */
export function isPurgedAccessResource(
  manifest: PlatformInstallationManifest,
  access: AccessResource,
): boolean {
  return manifest.steps.some((step) => step.key === accessStepKey(access));
}

function hasStep(manifest: PlatformInstallationManifest, key: string): boolean {
  return manifest.steps.some((step) => step.key === `${PURGE_RESOURCES_STEP_PREFIX}${key}`);
}

function keptStepKey(key: string): string {
  return `kept:${key}`;
}

/**
 * Why --purge-resources kept a resource it was going to delete, for example because
 * a route now serves another Worker; null when it did not keep it. Access
 * resources use the key `access:<key>`.
 */
export function purgeResourcesKeptReason(
  manifest: PlatformInstallationManifest,
  key: string,
): string | null {
  return (
    manifest.steps.find((step) => step.key === `${PURGE_RESOURCES_STEP_PREFIX}${keptStepKey(key)}`)
      ?.resultHash ?? null
  );
}

/** An uninstall that started has not finished, so what it kept can be reconsidered. */
function isReopenable(manifest: PlatformInstallationManifest): boolean {
  return manifest.status !== 'uninstalled';
}

/**
 * A resource the installation created that --purge-resources may still delete: one
 * that is ready, or one that an uninstall which stopped before it finished
 * recorded as retained. Resources --purge-resources itself kept, and earlier
 * versions of a resource kept when it was replaced, are never reconsidered.
 */
export function isPurgeResourcesCandidate(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  return (
    resource.ownership === 'created' &&
    (resource.state === 'ready' ||
      (resource.state === 'retained' &&
        isReopenable(manifest) &&
        !resource.key.startsWith('retained:') &&
        purgeResourcesKeptReason(manifest, resource.key) === null))
  );
}

/** The zone that routes and DNS records live in, if it can still be used. */
function usableZone(manifest: PlatformInstallationManifest): InstallationResource | undefined {
  return manifest.resources.find(
    (resource) =>
      resource.key === 'zone' &&
      (resource.state === 'ready' || (resource.state === 'retained' && isReopenable(manifest))),
  );
}

/**
 * A recorded resource whose live configuration no longer matches the
 * installation's record. --purge-resources keeps such a DNS record and continues.
 */
export class PlatformResourceChangedError extends Error {
  constructor(
    readonly resourceKey: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformResourceChangedError';
  }
}

/** The zone whose Email Routing rules may send mail to the gateway Worker. */
function emailRoutingZone(manifest: PlatformInstallationManifest): string | null {
  return manifest.deployment.capabilities.email
    ? (manifest.deployment.emailSharedZoneId ?? null)
    : null;
}

const rank = (resource: InstallationResource) => {
  const index = WORKER_ORDER.indexOf(resource.key);
  return index < 0 ? WORKER_ORDER.length : index;
};

/** Everything --purge-resources will delete, in deletion order. */
function purgeResourcesTargets(manifest: PlatformInstallationManifest): Array<Target> {
  const resources = manifest.resources;
  const routing = resources.find((resource) => resource.key === 'routing-kv');
  const candidate = (resource: InstallationResource) =>
    isPurgeResourcesCandidate(manifest, resource);
  // Without the remote checkpoint nothing can be proven, so nothing is deleted.
  if (!routing || (routing.state !== 'ready' && !candidate(routing))) {
    return [];
  }
  const zone = usableZone(manifest);
  const workers = resources.filter((resource) => resource.kind === 'worker' && candidate(resource));
  const targets: Array<Target> = [];
  for (const resource of resources) {
    if (
      (resource.kind !== 'worker-route' && resource.kind !== 'worker-custom-domain') ||
      (resource.state !== 'ready' && resource.state !== 'retained') ||
      (resource.kind === 'worker-route' && !zone) ||
      purgeResourcesKeptReason(manifest, resource.key) !== null
    ) {
      continue;
    }
    const name = platformTrafficAttachmentWorker(manifest.deployment, resource);
    const worker = workers.find((entry) => entry.name === name);
    if (worker) {
      targets.push({ phase: 'traffic', resource, worker });
    }
  }
  for (const resource of resources) {
    if (resource.kind === 'dns-record' && candidate(resource) && zone) {
      targets.push({ phase: 'dns', resource });
    }
  }
  const access = (manifest.authenticationResources ?? []).filter(
    (entry) =>
      entry.ownership === 'created' &&
      !isPurgedAccessResource(manifest, entry) &&
      purgeResourcesKeptReason(manifest, `access:${entry.key}`) === null,
  );
  // An application can admit the service token, so delete applications first.
  for (const kind of ['application', 'service-token'] as const) {
    for (const entry of access.filter((candidate) => candidate.kind === kind)) {
      targets.push({ phase: 'access', access: entry });
    }
  }
  // Rules that send mail to the gateway Worker go before the Worker.
  const gateway = workers.find((worker) => worker.key === 'email-gateway-worker');
  if (gateway && emailRoutingZone(manifest) && !hasStep(manifest, 'email-routing')) {
    targets.push({ phase: 'email', resource: gateway });
  }
  const queues = resources.filter((resource) => resource.kind === 'queue' && candidate(resource));
  for (const resource of queues) {
    if (!hasStep(manifest, `consumers:${resource.key}`)) {
      targets.push({ phase: 'queue-consumers', resource });
    }
  }
  for (const resource of workers
    .filter((worker) => !isPlatformTailWorker(manifest, worker))
    .sort((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key))) {
    targets.push({ phase: 'workers', resource });
  }
  for (const resource of queues) {
    targets.push({ phase: 'queues', resource });
  }
  for (const resource of resources) {
    if (resource.kind === 'dispatch-namespace' && candidate(resource)) {
      targets.push({ phase: 'dispatch', resource });
    }
  }
  for (const resource of workers.filter((worker) => isPlatformTailWorker(manifest, worker))) {
    targets.push({ phase: 'tail', resource });
  }
  for (const kind of ['hyperdrive', 'kv-namespace'] as const) {
    for (const resource of resources) {
      if (resource.kind === kind && resource.key !== 'routing-kv' && candidate(resource)) {
        targets.push({ phase: 'data', resource });
      }
    }
  }
  for (const kind of ['r2-bucket', 'ai-gateway'] as const) {
    for (const resource of resources) {
      if (resource.kind === kind && candidate(resource)) {
        targets.push({ phase: kind === 'r2-bucket' ? 'r2' : 'ai-gateway', resource });
      }
    }
  }
  if (candidate(routing)) {
    targets.push({ phase: 'routing', resource: routing });
  }
  return targets;
}

/** Whether --purge-resources removes, or has removed, the rules that send mail to the gateway Worker. */
export function purgeResourcesHandlesEmailRouting(manifest: PlatformInstallationManifest): boolean {
  return (
    hasStep(manifest, 'email-routing') ||
    purgeResourcesTargets(manifest).some((target) => target.phase === 'email')
  );
}

/** Manifest resources that --purge-resources leaves in the account. */
export function purgeResourcesKeptResources(
  manifest: PlatformInstallationManifest,
): Array<InstallationResource> {
  const targets = new Set(
    purgeResourcesTargets(manifest).flatMap((target) =>
      'resource' in target ? [target.resource.key] : [],
    ),
  );
  return manifest.resources.filter(
    (resource) =>
      (resource.state === 'ready' || resource.state === 'retained') && !targets.has(resource.key),
  );
}

function resourceLabel(resource: InstallationResource): string {
  return `${resource.kind}: ${resource.name}${resource.name === resource.id ? '' : ` (${resource.id})`}`;
}

/** Plan lines for --purge-resources: what is deleted, in order, then what is kept. */
export function describePurgeResourcesPlan(manifest: PlatformInstallationManifest): Array<string> {
  const targets = purgeResourcesTargets(manifest);
  const lines: Array<string> = [];
  let step = 0;
  let previous: Target['phase'] | null = null;
  const consumerQueues: Array<string> = [];
  for (const target of targets) {
    if (target.phase === 'email') {
      step++;
      previous = target.phase;
      lines.push(
        `  ${step}. Email Routing rules in zone ${emailRoutingZone(manifest)} that send mail to ${target.resource.name}, and its catch-all rule if it does (reset to drop mail, disabled)`,
      );
      continue;
    }
    if (target.phase !== previous) {
      step++;
      previous = target.phase;
    }
    const prefix = `  ${step}. `;
    if (target.phase === 'traffic') {
      lines.push(`${prefix}${resourceLabel(target.resource)} -> ${target.worker.name}`);
    } else if (target.phase === 'access') {
      lines.push(
        `${prefix}Access ${target.access.kind}: ${target.access.name} (${target.access.id})`,
      );
    } else if (target.phase === 'queue-consumers') {
      consumerQueues.push(target.resource.name);
      if (consumerQueues.length === 1) {
        lines.push(`${prefix}queue consumers run by this installation's Workers on:`);
      }
      lines.push(`       ${target.resource.name}`);
    } else if (target.phase === 'dispatch') {
      lines.push(
        `${prefix}${resourceLabel(target.resource)}, with any application Workers still in it`,
      );
    } else if (target.phase === 'tail') {
      lines.push(`${prefix}${resourceLabel(target.resource)}, the tail Worker, after the others`);
    } else if (target.phase === 'workers' && target.resource.key === 'api-worker') {
      lines.push(`${prefix}${resourceLabel(target.resource)}, with its Durable Object data`);
    } else if (target.phase === 'r2') {
      lines.push(`${prefix}${resourceLabel(target.resource)}, emptied first`);
    } else if (target.phase === 'ai-gateway') {
      lines.push(
        `${prefix}${resourceLabel(target.resource)}, if Cloudflare shows it was created during installation; otherwise kept`,
      );
    } else if (target.phase === 'routing') {
      lines.push(`${prefix}${resourceLabel(target.resource)}, last; it holds uninstall progress`);
    } else {
      lines.push(`${prefix}${resourceLabel(target.resource)}`);
    }
  }
  return lines.length
    ? [
        'Delete every resource this installation created (--purge-resources), in this order:',
        ...lines,
      ]
    : ['--purge-resources finds no resource it can prove this installation created.'];
}

/** Lines naming what --purge-resources never removes. */
export function purgeResourcesAlwaysKept(): Array<string> {
  return [
    '  The external PostgreSQL database and its data.',
    '  Analytics Engine datasets; Cloudflare has no API to delete them.',
    '  Access policies and identity providers you chose.',
    '  API tokens you created for this platform. Revoke them in the Cloudflare dashboard.',
  ];
}

/** Token permissions --purge-resources needs for this manifest. */
export function purgeResourcesPermissions(manifest: PlatformInstallationManifest): Array<string> {
  const targets = purgeResourcesTargets(manifest);
  const needed = new Set<string>();
  for (const target of targets) {
    if (target.phase === 'access') {
      needed.add(
        target.access.kind === 'application' ? PERMISSIONS.access : PERMISSIONS.serviceTokens,
      );
      continue;
    }
    if (target.phase === 'email') {
      needed.add(PERMISSIONS.emailRouting);
      continue;
    }
    const { kind } = target.resource;
    if (kind === 'worker-route') {
      needed.add(PERMISSIONS.routes);
    } else if (
      kind === 'worker' ||
      kind === 'worker-custom-domain' ||
      kind === 'dispatch-namespace'
    ) {
      needed.add(PERMISSIONS.workers);
    } else if (kind === 'dns-record') {
      needed.add(PERMISSIONS.dns);
    } else if (kind === 'queue') {
      needed.add(PERMISSIONS.queues);
    } else if (kind === 'kv-namespace') {
      needed.add(PERMISSIONS.kv);
    } else if (kind === 'hyperdrive') {
      needed.add(PERMISSIONS.hyperdrive);
    } else if (kind === 'r2-bucket') {
      needed.add(PERMISSIONS.r2);
    } else if (kind === 'ai-gateway') {
      needed.add(PERMISSIONS.aiGateway);
    }
  }
  return Object.values(PERMISSIONS).filter((permission) => needed.has(permission));
}

function deniedStatus(error: unknown): boolean {
  return (
    error instanceof PlatformCloudflareApiError && (error.status === 401 || error.status === 403)
  );
}

/**
 * Check resource reads before the first change. Browser login cannot change
 * DNS or Access, so those need an API token. Read probes cannot prove Edit;
 * the plan lists the required permissions.
 */
export async function checkPurgeResourcesCredentials(
  client: PurgeResourcesClient,
  manifest: PlatformInstallationManifest,
  credential: PurgeResourcesCredential,
): Promise<void> {
  const targets = purgeResourcesTargets(manifest);
  const resources = targets.flatMap((target) => ('resource' in target ? [target.resource] : []));
  const access = targets.flatMap((target) => ('access' in target ? [target.access] : []));
  const has = (kind: InstallationResource['kind']) =>
    resources.some((resource) => resource.kind === kind);
  const zone = manifest.resources.find((resource) => resource.key === 'zone');
  const emailZone = targets.some((target) => target.phase === 'email')
    ? emailRoutingZone(manifest)
    : null;
  // Access can live in a separate identity account.
  const accounts = [...new Set([manifest.account.id, ...access.map((entry) => entry.accountId)])];
  const scope = `${accounts.length === 1 ? 'account' : 'accounts'} ${accounts.join(' and ')}${has('dns-record') || has('worker-route') ? ` and zone ${zone?.name ?? ''}` : ''}${emailZone ? ` and Email Routing zone ${emailZone}` : ''}`;
  if (credential.source === 'oauth') {
    const browserMissing = [
      ...(has('dns-record') ? [PERMISSIONS.dns] : []),
      ...(access.some((entry) => entry.kind === 'application') ? [PERMISSIONS.access] : []),
      ...(access.some((entry) => entry.kind === 'service-token')
        ? [PERMISSIONS.serviceTokens]
        : []),
      ...(has('ai-gateway') && !credential.aiGatewayToken ? [PERMISSIONS.aiGateway] : []),
    ];
    if (browserMissing.length) {
      throw new Error(
        `platform: Cloudflare browser login cannot delete every resource --purge-resources plans. Set CLOUDFLARE_API_TOKEN to a token with ${purgeResourcesPermissions(manifest).join(', ')}, scoped to ${scope}, then rerun. Browser login is missing: ${browserMissing.join(', ')}. No Cloudflare resource was changed.`,
      );
    }
  }
  const probes: Array<[string, () => Promise<unknown>]> = [];
  if (has('worker') || has('worker-custom-domain')) {
    probes.push([PERMISSIONS.workers, () => client.listWorkerNames(manifest.account.id)]);
  }
  if (has('worker-custom-domain')) {
    probes.push([PERMISSIONS.workers, () => client.listWorkerDomains(manifest.account.id)]);
  }
  if (has('worker-route') && zone) {
    probes.push([PERMISSIONS.routes, () => client.listWorkerRoutes(zone.id)]);
  }
  for (const resource of resources) {
    if (resource.kind === 'dns-record' && zone) {
      probes.push([PERMISSIONS.dns, () => client.listDnsRecords(zone.id, resource.name)]);
    } else if (resource.kind === 'queue') {
      probes.push([
        PERMISSIONS.queues,
        () => client.listQueueConsumers(manifest.account.id, resource.id),
      ]);
    }
  }
  for (const entry of access) {
    probes.push([
      entry.kind === 'application' ? PERMISSIONS.access : PERMISSIONS.serviceTokens,
      () => client.getAccessResource(entry.accountId, entry.kind, entry.id),
    ]);
  }
  if (emailZone) {
    probes.push([PERMISSIONS.emailRouting, () => client.listEmailRoutingRules(emailZone)]);
  }
  if (has('dispatch-namespace')) {
    probes.push([PERMISSIONS.workers, () => client.listDispatchNamespaces(manifest.account.id)]);
  }
  if (has('kv-namespace')) {
    probes.push([PERMISSIONS.kv, () => client.listKvNamespaces(manifest.account.id)]);
  }
  if (has('hyperdrive')) {
    probes.push([PERMISSIONS.hyperdrive, () => client.listHyperdriveConfigs(manifest.account.id)]);
  }
  if (has('r2-bucket')) {
    probes.push([PERMISSIONS.r2, () => client.listR2Buckets(manifest.account.id)]);
  }
  if (has('ai-gateway')) {
    probes.push([PERMISSIONS.aiGateway, () => client.listAiGateways(manifest.account.id)]);
  }
  const missing = new Set<string>();
  for (const [permission, probe] of probes) {
    try {
      await probe();
    } catch (error) {
      if (!deniedStatus(error)) {
        throw error;
      }
      missing.add(permission);
    }
  }
  if (missing.size) {
    throw new Error(
      `platform: The Cloudflare credential cannot read every resource --purge-resources would delete. Add ${[...missing].join(', ')} for ${scope}, then rerun. No Cloudflare resource was changed.`,
    );
  }
}

const LISTED_PROJECTS = 20;

/**
 * Projects own Workers, storage, and domains that only the running platform
 * can delete. --purge-resources deletes the platform, so it refuses before any
 * change while a project remains.
 */
export async function assertNoPlatformProjects(
  read: (() => Promise<ReadonlyArray<string>>) | undefined,
): Promise<void> {
  const slugs = await readPlatformDatabase(
    read,
    (reason) =>
      `platform: Refusing --purge-resources because the project list could not be read from the platform database: ${reason}\nMake the installation database reachable (export VOID_PLATFORM_DATABASE_URL if this machine has not recorded it), then retry.`,
  );
  if (slugs.length) {
    throw new Error(
      [
        `platform: Refusing --purge-resources while the platform still has ${slugs.length === 1 ? '1 project' : `${slugs.length} projects`}.`,
        "--purge-resources deletes the platform, and only the running platform can delete each project's Workers, storage, and domains.",
        'Delete each project first with `void project delete <name>`, then retry:',
        ...slugs.slice(0, LISTED_PROJECTS).map((slug) => `  ${slug}`),
        ...(slugs.length > LISTED_PROJECTS
          ? [`  …and ${slugs.length - LISTED_PROJECTS} more`]
          : []),
      ].join('\n'),
    );
  }
}

export type PurgeResourcesContext = Readonly<{
  client: PurgeResourcesClient;
  /** Save progress locally, in PostgreSQL, and in routing KV. */
  checkpoint: (manifest: PlatformInstallationManifest) => Promise<void>;
  /** Live ownership proof for these keys; returns the keys that no longer exist. */
  verify: (
    manifest: PlatformInstallationManifest,
    keys: ReadonlySet<string>,
  ) => Promise<ReadonlySet<string>>;
  /**
   * A value that changes when the bucket is deleted and created again under
   * the same name; null when the bucket is gone.
   */
  bucketGeneration: (
    manifest: PlatformInstallationManifest,
    bucket: InstallationResource,
  ) => Promise<string | null>;
  /** Project slugs in the platform database. */
  readProjects: () => Promise<ReadonlyArray<string>>;
}>;

// The installer records a provision intent right before it creates the AI
// Gateway. Allow for clock differences between this machine and Cloudflare.
const AI_GATEWAY_CREATION_WINDOW_MS = 10 * 60_000;

/**
 * AI Gateway ids are chosen by the caller and can be reused after a delete,
 * and gateways carry no ownership marker. Only a creation time next to the
 * installer's provision intent shows that this is the gateway it created.
 */
function createdDuringInstallation(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  createdAt: string | undefined,
): boolean {
  const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return false;
  }
  return manifest.steps.some(
    (step) =>
      (step.key === `provision-intent:${resource.key}` ||
        step.key.startsWith(`provision-intent:${resource.key}:`)) &&
      Math.abs(created - Date.parse(step.completedAt)) <= AI_GATEWAY_CREATION_WINDOW_MS,
  );
}

function ownershipRefusal(
  manifest: PlatformInstallationManifest,
  description: string,
  reason: string,
): Error {
  return new Error(
    `platform: Refusing to delete ${description} because ${reason}. It may no longer belong to this installation. Delete or fix it in the Cloudflare dashboard if it is yours, then rerun: ${purgeResourcesResumeCommand(manifest)}`,
  );
}

function cloudflareRefusal(
  manifest: PlatformInstallationManifest,
  description: string,
  error: unknown,
  hint: string,
): unknown {
  if (!(error instanceof PlatformCloudflareApiError)) {
    return error;
  }
  return new Error(
    `platform: Cloudflare refused to delete ${description}: ${error.message}\n${hint}\nProgress is saved. Rerun: ${purgeResourcesResumeCommand(manifest)}`,
    { cause: error },
  );
}

/**
 * Delete every target in order. Returns the manifest with each deleted
 * resource recorded; routing KV is left for the caller to delete last.
 */
export async function runPurgeResourcesTeardown(
  context: PurgeResourcesContext,
  initial: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest> {
  const { client } = context;
  let next = initial;
  const accountId = next.account.id;
  const save = async (manifest: PlatformInstallationManifest) => {
    next = manifest;
    await context.checkpoint(next);
  };
  const markDeleted = async (key: string) => {
    const resource = next.resources.find((entry) => entry.key === key);
    if (!resource) {
      throw new Error(`platform: Missing teardown resource ${key}.`);
    }
    await save(
      recordInstallationResource(next, { ...resource, state: 'deleted' }, new Date().toISOString()),
    );
  };
  const recordStep = async (key: string, resultHash = 'completed') => {
    const now = new Date().toISOString();
    await save(
      recordInstallationStep(
        next,
        { completedAt: now, key: `${PURGE_RESOURCES_STEP_PREFIX}${key}`, resultHash },
        now,
      ),
    );
  };
  /**
   * Live proof for these keys. A resource an earlier uninstall recorded as
   * retained is proven like a ready one; only its recorded state differs.
   */
  const verify = (keys: ReadonlySet<string>) =>
    context.verify(
      {
        ...next,
        resources: next.resources.map((resource) =>
          keys.has(resource.key) && resource.state === 'retained'
            ? { ...resource, state: 'ready' as const }
            : resource,
        ),
      },
      keys,
    );
  /**
   * Prove the resource; false when it is already gone (and recorded).
   *
   * Cloudflare has no conditional DELETE: Workers and dispatch namespaces are
   * addressed by name, and a route or custom domain can be changed in place.
   * Something replaced between this proof and the DELETE can still be removed.
   * That one-request window is accepted because --purge-resources is opt-in and its
   * plan lists every resource first. A forced Worker DELETE has the same
   * window between reading its dependents and the DELETE.
   */
  const prove = async (resource: InstallationResource): Promise<boolean> => {
    const missing = await verify(new Set(['routing-kv', resource.key]));
    if (missing.has(resource.key)) {
      await markDeleted(resource.key);
      return false;
    }
    return true;
  };
  /** Keep a resource that no longer matches the record, and save why. */
  const keep = async (key: string, reason: string) => {
    const resource = next.resources.find((entry) => entry.key === key);
    if (resource?.state === 'ready') {
      await save(
        recordInstallationResource(
          next,
          { ...resource, state: 'retained' },
          new Date().toISOString(),
        ),
      );
    }
    await recordStep(keptStepKey(key), reason);
  };
  const remove = async (resource: InstallationResource, hint: string, zoneId?: string) => {
    if (!(await prove(resource))) {
      return;
    }
    try {
      await client.deleteResource(accountId, resource, zoneId);
    } catch (error) {
      throw cloudflareRefusal(next, `${resource.kind} ${resource.name}`, error, hint);
    }
    await markDeleted(resource.key);
  };
  const zone = usableZone(next);
  const createdWorkerNames = new Set(
    next.resources
      .filter((resource) => resource.kind === 'worker' && resource.ownership === 'created')
      .map((resource) => resource.name),
  );
  /** The recorded Worker under this name that this run still deletes, if any. */
  const workerTarget = (name: string) =>
    next.resources.find(
      (resource) =>
        resource.kind === 'worker' &&
        resource.name === name &&
        isPurgeResourcesCandidate(next, resource),
    );
  const workerHint =
    'A Worker this installation did not create may still use it, for example by sending it logs as a tail Worker or through a service binding. Remove that link in the Cloudflare dashboard.';
  /**
   * Delete a platform Worker. When Cloudflare refuses because other Workers
   * still bind to it, force the DELETE only if each of them is a Worker this
   * run deletes too and still carries this installation's ownership marker.
   */
  const removeWorker = async (resource: InstallationResource) => {
    if (!(await prove(resource))) {
      return;
    }
    try {
      await client.deleteResource(accountId, resource);
    } catch (error) {
      if (!(error instanceof PlatformCloudflareApiError)) {
        throw error;
      }
      const dependents = await client
        .listWorkerDependents(accountId, resource.name)
        .catch(() => null);
      const outside: Array<string> = [];
      const keys: Array<string> = [];
      // Prove each dependent live, like the Worker itself: a name match alone
      // could be another Worker that took a recorded name.
      for (const name of dependents?.workers ?? []) {
        const worker = workerTarget(name);
        if (worker) {
          keys.push(worker.key);
        } else {
          outside.push(name);
        }
      }
      const missing =
        dependents && !dependents.pagesFunction && outside.length === 0 && keys.length
          ? await verify(new Set(['routing-kv', ...keys]))
          : null;
      if (
        !dependents ||
        dependents.pagesFunction ||
        dependents.workers.length === 0 ||
        outside.length > 0 ||
        !missing ||
        keys.some((key) => missing.has(key))
      ) {
        throw cloudflareRefusal(
          next,
          `${resource.kind} ${resource.name}`,
          error,
          outside.length
            ? `Workers outside this installation still use it: ${outside.join(', ')}. Remove that link in the Cloudflare dashboard.`
            : workerHint,
        );
      }
      try {
        await client.forceDeleteWorker(accountId, resource.name);
      } catch (forced) {
        throw cloudflareRefusal(next, `${resource.kind} ${resource.name}`, forced, workerHint);
      }
    }
    await markDeleted(resource.key);
  };

  for (const target of purgeResourcesTargets(initial)) {
    if (target.phase === 'access') {
      const { access } = target;
      const live = await client.getAccessResource(access.accountId, access.kind, access.id);
      if (live) {
        if (live.name !== access.name || !access.name.startsWith(`void-${next.id}-`)) {
          await keep(
            `access:${access.key}`,
            `its live name ${JSON.stringify(live.name)} is not the name this installation recorded`,
          );
          continue;
        }
        try {
          await client.deleteAccessResource(access.accountId, access.kind, access.id);
        } catch (error) {
          throw cloudflareRefusal(
            next,
            `Access ${access.kind} ${access.name}`,
            error,
            'Check that nothing outside this installation still uses it.',
          );
        }
      }
      await recordStep(`access:${access.key}`);
      continue;
    }
    const current = next.resources.find((resource) => resource.key === target.resource.key);
    // Already handled on an earlier run, or by an earlier step of this one.
    if (
      !current ||
      current.state === 'deleted' ||
      purgeResourcesKeptReason(next, current.key) !== null ||
      (target.phase !== 'traffic' && !isPurgeResourcesCandidate(next, current))
    ) {
      continue;
    }
    switch (target.phase) {
      case 'traffic': {
        const worker = next.resources.find((resource) => resource.key === target.worker.key);
        if (!worker || !isPurgeResourcesCandidate(next, worker) || !(await prove(worker))) {
          // The Worker it served is gone, so the attachment cannot be proven.
          break;
        }
        if (current.kind === 'worker-route') {
          if (!zone) {
            throw new Error('platform: Cannot verify the route without its zone.');
          }
          const live = (await client.listWorkerRoutes(zone.id)).find(
            (route) => route.id === current.id,
          );
          if (live && (live.pattern !== current.name || live.script !== worker.name)) {
            await keep(
              current.key,
              `it now sends ${JSON.stringify(live.pattern)} to ${JSON.stringify(live.script)}`,
            );
            break;
          }
          if (live) {
            await client.deleteWorkerRoute(zone.id, current.id);
          }
        } else {
          const live = (await client.listWorkerDomains(accountId)).find(
            (domain) => domain.id === current.id,
          );
          if (live && (live.hostname !== current.name || live.service !== worker.name)) {
            await keep(
              current.key,
              `it now sends ${JSON.stringify(live.hostname)} to ${JSON.stringify(live.service)}`,
            );
            break;
          }
          if (live) {
            await client.deleteWorkerDomain(accountId, current.id);
          }
        }
        await markDeleted(current.key);
        break;
      }
      case 'dns':
        if (!zone) {
          throw new Error('platform: Cannot verify the DNS record without its zone.');
        }
        try {
          await remove(current, 'Check the record in the Cloudflare dashboard.', zone.id);
        } catch (error) {
          if (
            !(error instanceof PlatformResourceChangedError && error.resourceKey === current.key)
          ) {
            throw error;
          }
          await keep(current.key, error.reason);
        }
        break;
      case 'email': {
        // Prove the gateway Worker is still this installation's before
        // touching rules that send mail to it.
        if (!(await prove(current))) {
          break;
        }
        const zoneId = emailRoutingZone(next);
        if (!zoneId) {
          throw new Error('platform: Cannot verify Email Routing without its zone.');
        }
        const hint =
          'Check the Email Routing rules for this zone in the Cloudflare dashboard. Never disable Email Routing for the zone.';
        try {
          for (const rule of await client.listEmailRoutingRules(zoneId)) {
            if (rule.workerName === current.name) {
              await client.deleteEmailRoutingRule(zoneId, rule.id);
            }
          }
          const catchAll = await client.getEmailRoutingCatchAll(zoneId);
          if (catchAll?.workerName === current.name) {
            await client.resetEmailRoutingCatchAll(zoneId);
          }
        } catch (error) {
          throw cloudflareRefusal(
            next,
            `Email Routing rules that send mail to ${current.name}`,
            error,
            hint,
          );
        }
        await recordStep('email-routing');
        break;
      }
      case 'queue-consumers': {
        if (!(await prove(current))) {
          break;
        }
        for (const consumer of await client.listQueueConsumers(accountId, current.id)) {
          if (consumer.script && createdWorkerNames.has(consumer.script)) {
            await client.deleteQueueConsumer(accountId, current.id, consumer.id);
          }
        }
        await recordStep(`consumers:${current.key}`);
        break;
      }
      case 'workers':
        await removeWorker(current);
        break;
      case 'tail':
        await remove(current, workerHint);
        break;
      case 'queues':
        await remove(
          current,
          'A Worker this installation did not create may still use the Queue as a producer or consumer. Remove it from that Worker in the Cloudflare dashboard.',
        );
        break;
      case 'dispatch': {
        if (!(await prove(current))) {
          break;
        }
        // A platform API that creates projects without the configuration
        // lock can add one after the final check, and it owns an application
        // Worker here.
        const projects = await context.readProjects();
        if (projects.length) {
          throw new Error(
            `platform: Stopped before deleting the application Workers in dispatch namespace ${current.name} because ${projects.length === 1 ? 'a project was' : 'projects were'} created while this uninstall ran: ${projects.join(', ')}. Nothing in the namespace was deleted. --purge-resources refuses while the platform database lists a project. Remove each one from the "projects" table once you have dealt with its Cloudflare resources, then rerun: ${purgeResourcesResumeCommand(next)}`,
          );
        }
        for (const script of await client.listDispatchNamespaceScripts(accountId, current.name)) {
          try {
            await client.deleteDispatchNamespaceScript(accountId, current.name, script);
          } catch (error) {
            throw cloudflareRefusal(next, `application Worker ${script}`, error, workerHint);
          }
        }
        try {
          await client.deleteResource(accountId, current);
        } catch (error) {
          throw cloudflareRefusal(
            next,
            `dispatch-namespace ${current.name}`,
            error,
            'Check the namespace in the Cloudflare dashboard.',
          );
        }
        await markDeleted(current.key);
        break;
      }
      case 'ai-gateway': {
        const live = (await client.listAiGateways(accountId)).find(
          (gateway) => gateway.id === current.id && gateway.name === current.name,
        );
        if (live && !createdDuringInstallation(next, current, live.createdAt)) {
          // It may be a replacement with the same id, so keep and list it.
          await keep(current.key, 'Cloudflare does not show it was created during installation');
          break;
        }
        await remove(current, 'Check that nothing outside this installation still uses it.');
        break;
      }
      case 'data':
        await remove(current, 'Check that nothing outside this installation still uses it.');
        break;
      case 'r2':
        await purgeBucket(current);
        break;
      case 'routing':
        // The caller deletes routing KV after recording completion.
        break;
    }
  }
  return next;

  async function purgeBucket(bucket: InstallationResource): Promise<void> {
    const markerStep = `r2-marker:${bucket.key}`;
    if (!hasStep(next, markerStep)) {
      if (!(await prove(bucket))) {
        return;
      }
      // Keep the ownership marker until last, and prove the bucket again
      // before every page of deletes.
      await client.emptyR2Bucket(
        accountId,
        bucket.name,
        new Set([PLATFORM_R2_OWNERSHIP_MARKER_KEY]),
        async () => {
          const missing = await verify(new Set(['routing-kv', bucket.key]));
          if (missing.has(bucket.key)) {
            throw ownershipRefusal(
              next,
              `R2 bucket ${bucket.name}`,
              'it disappeared while it was being emptied',
            );
          }
        },
      );
      if (!(await prove(bucket))) {
        return;
      }
      // Once the marker is gone, the generation saved with this step is the
      // proof that a rerun still sees the same bucket.
      const generation = await context.bucketGeneration(next, bucket);
      if (generation === null) {
        await markDeleted(bucket.key);
        return;
      }
      await recordStep(markerStep, generation);
      await client.deleteR2Object(accountId, bucket.name, PLATFORM_R2_OWNERSHIP_MARKER_KEY);
    } else {
      const saved = next.steps.find(
        (step) => step.key === `${PURGE_RESOURCES_STEP_PREFIX}${markerStep}`,
      );
      const generation = await context.bucketGeneration(next, bucket);
      if (generation === null) {
        await markDeleted(bucket.key);
        return;
      }
      if (generation !== saved?.resultHash) {
        throw ownershipRefusal(
          next,
          `R2 bucket ${bucket.name}`,
          'its creation fingerprint changed',
        );
      }
      await client.deleteR2Object(accountId, bucket.name, PLATFORM_R2_OWNERSHIP_MARKER_KEY);
    }
    try {
      await client.deleteResource(accountId, bucket);
    } catch (error) {
      throw cloudflareRefusal(
        next,
        `r2-bucket ${bucket.name}`,
        error,
        'Cloudflare deletes only empty buckets. If objects were added after it was emptied, delete them in the Cloudflare dashboard.',
      );
    }
    await markDeleted(bucket.key);
  }
}
