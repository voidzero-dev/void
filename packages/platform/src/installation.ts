import { createPlatformDeploymentManifest, parsePlatformDeploymentManifest } from './manifest.ts';
import type { PlatformDeploymentManifest } from './manifest.ts';
import {
  assertRecord,
  isSandboxDrainProtocol,
  isSourceRevision,
  isUsageProtocolVersion,
  requiredString,
} from './validate.ts';

export const PLATFORM_INSTALLATION_SCHEMA_VERSION = 1 as const;
export const PLATFORM_DISABLED_KEY = '__void/platform/disabled/v1';
export const PLATFORM_DISABLED_VALUE = 'disabled';
export const PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY = '__void/platform/installation/v1';
export const PLATFORM_SANDBOX_DRAIN_KEY = '__void/platform/sandbox-drain/v1';
export const PLATFORM_R2_OWNERSHIP_MARKER_KEY = '__void/platform/ownership/v1';
export const PLATFORM_RESOURCE_OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const PLATFORM_USAGE_PROTOCOL_VERSION = 2 as const;

export type InstallationStatus =
  | 'draft'
  | 'planned'
  | 'provisioning'
  | 'waiting-for-dns'
  | 'waiting-for-oauth'
  | 'deploying'
  | 'verifying'
  | 'installed'
  | 'disabling'
  | 'disabled'
  | 'uninstalling'
  | 'uninstalled'
  | 'failed';

export type ResourceOwnership = 'created' | 'adopted' | 'external';

export type InstallationResourceKind =
  | 'ai-gateway'
  | 'analytics-dataset'
  | 'dispatch-namespace'
  | 'dns-record'
  | 'hyperdrive'
  | 'kv-namespace'
  | 'queue'
  | 'r2-bucket'
  | 'worker'
  | 'worker-custom-domain'
  | 'worker-route'
  | 'zone';

export type InstallationResource = Readonly<{
  configHash: string;
  id: string;
  key: string;
  kind: InstallationResourceKind;
  name: string;
  ownership: ResourceOwnership;
  state: 'ready' | 'retained' | 'deleted';
}>;

export type InstallationStep = Readonly<{
  completedAt: string;
  key: string;
  resultHash: string;
}>;

export type PlatformInstallationEndpoints = Readonly<{
  apiUrl: string | null;
  dashboardUrl: string | null;
  proxyUrl: string | null;
}>;

export type PlatformRuntimeProvenance = Readonly<{
  manifestSha256: string;
  source: 'custom' | 'package';
  sourceRevision: string | null;
}>;

/** Saved operator progress; this does not attest application availability. */
export type PlatformLifecycleOperation = Readonly<{
  id: string;
  action: 'install' | 'upgrade' | 'rollback' | 'repair' | 'enable';
  fromVersion: string | null;
  toVersion: string;
  runtimeManifestSha256?: string;
  phase:
    | 'preparing'
    | 'deploying'
    | 'verifying'
    | 'enabling'
    | 'waiting-for-dns'
    | 'waiting-for-sandbox-drain'
    | 'complete'
    | 'failed';
  startedAt: string;
  updatedAt: string;
}>;

export function parsePlatformLifecycleOperation(value: unknown): PlatformLifecycleOperation {
  assertRecord(value, 'operation');
  const actions = ['install', 'upgrade', 'rollback', 'repair', 'enable'] as const;
  const phases = [
    'preparing',
    'deploying',
    'verifying',
    'enabling',
    'waiting-for-dns',
    'waiting-for-sandbox-drain',
    'complete',
    'failed',
  ] as const;
  const action = actions.find((action) => action === value.action);
  const phase = phases.find((phase) => phase === value.phase);
  if (!action || !phase) {
    throw new Error('Invalid platform operation action or phase.');
  }
  if (
    value.runtimeManifestSha256 !== undefined &&
    (typeof value.runtimeManifestSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.runtimeManifestSha256))
  ) {
    throw new Error('Invalid platform operation runtime digest.');
  }
  return {
    id: requiredString(value.id, 'operation.id'),
    action,
    fromVersion:
      value.fromVersion === null
        ? null
        : requiredString(value.fromVersion, 'operation.fromVersion'),
    toVersion: requiredString(value.toVersion, 'operation.toVersion'),
    ...(typeof value.runtimeManifestSha256 === 'string'
      ? { runtimeManifestSha256: value.runtimeManifestSha256 }
      : {}),
    phase,
    startedAt: assertTimestamp(
      requiredString(value.startedAt, 'operation.startedAt'),
      'operation.startedAt',
    ),
    updatedAt: assertTimestamp(
      requiredString(value.updatedAt, 'operation.updatedAt'),
      'operation.updatedAt',
    ),
  };
}

export type PlatformInstallationManifest = Readonly<{
  authenticationResources?: ReadonlyArray<
    Readonly<{
      key: string;
      kind: 'application' | 'service-token';
      accountId: string;
      id: string;
      name: string;
      ownership: 'created' | 'adopted';
    }>
  >;
  account: Readonly<{
    id: string;
    name: string;
  }>;
  createdAt: string;
  /** Actual forward-only PostgreSQL schema, independent of the running runtime. */
  databaseSchemaDigest: string | null;
  deployment: PlatformDeploymentManifest;
  /** Last durable deployment execution protocol activated by the installer. */
  deploymentExecution?: 1;
  /** Desired domain while DNS/TLS activation is pending; current addressing remains live. */
  pendingDomain?: PlatformDeploymentManifest['application'];
  desiredState: 'enabled' | 'disabled';
  endpoints: PlatformInstallationEndpoints;
  id: string;
  ownershipNonce: string;
  operation?: PlatformLifecycleOperation;
  platformVersion: string;
  resources: ReadonlyArray<InstallationResource>;
  runtime: PlatformRuntimeProvenance | null;
  safetyProtocols: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>;
  schemaVersion: typeof PLATFORM_INSTALLATION_SCHEMA_VERSION;
  status: InstallationStatus;
  steps: ReadonlyArray<InstallationStep>;
  updatedAt: string;
  /** Last usage protocol proven live across the installed Worker set. */
  usageProtocolVersion: 0 | 1 | 2;
}>;

export type PlatformResourceOwnershipMarker = Readonly<{
  accountId: string;
  installationId: string;
  ownershipNonce: string;
  resourceId: string;
  resourceKey: string;
  resourceKind: InstallationResourceKind;
  resourceName: string;
  schemaVersion: typeof PLATFORM_RESOURCE_OWNERSHIP_SCHEMA_VERSION;
}>;

const STATUS_TRANSITIONS: Readonly<Record<InstallationStatus, ReadonlyArray<InstallationStatus>>> =
  {
    draft: ['planned', 'failed', 'uninstalling'],
    planned: ['provisioning', 'failed', 'uninstalling'],
    provisioning: [
      'waiting-for-dns',
      'waiting-for-oauth',
      'deploying',
      'disabling',
      'failed',
      'uninstalling',
    ],
    'waiting-for-dns': ['provisioning', 'disabling', 'failed', 'uninstalling'],
    'waiting-for-oauth': ['provisioning', 'deploying', 'disabling', 'failed', 'uninstalling'],
    // Re-enter provisioning after a hard interruption. Every provisioning and
    // deployment step is checkpointed/idempotent, so resume safely reconciles
    // resources before redeploying and verifying again.
    deploying: ['provisioning', 'verifying', 'disabling', 'disabled', 'failed', 'uninstalling'],
    verifying: ['provisioning', 'installed', 'disabling', 'failed', 'uninstalling'],
    installed: ['provisioning', 'disabling', 'uninstalling', 'failed'],
    disabling: ['disabled', 'failed', 'uninstalling'],
    disabled: ['provisioning', 'uninstalling', 'failed'],
    uninstalling: ['uninstalled', 'failed'],
    uninstalled: [],
    failed: ['planned', 'provisioning', 'deploying', 'verifying', 'disabling', 'uninstalling'],
  };

function isInstallationStatus(value: unknown): value is InstallationStatus {
  return typeof value === 'string' && Object.hasOwn(STATUS_TRANSITIONS, value);
}

function isResourceKind(value: unknown): value is InstallationResourceKind {
  return (
    value === 'ai-gateway' ||
    value === 'analytics-dataset' ||
    value === 'dispatch-namespace' ||
    value === 'dns-record' ||
    value === 'hyperdrive' ||
    value === 'kv-namespace' ||
    value === 'queue' ||
    value === 'r2-bucket' ||
    value === 'worker' ||
    value === 'worker-custom-domain' ||
    value === 'worker-route' ||
    value === 'zone'
  );
}

function isOwnership(value: unknown): value is ResourceOwnership {
  return value === 'created' || value === 'adopted' || value === 'external';
}

function isResourceState(value: unknown): value is InstallationResource['state'] {
  return value === 'ready' || value === 'retained' || value === 'deleted';
}

function assertTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

export function createPlatformResourceOwnershipMarker(input: {
  accountId: string;
  installationId: string;
  ownershipNonce: string;
  resourceId: string;
  resourceKey: string;
  resourceKind: InstallationResourceKind;
  resourceName: string;
}): PlatformResourceOwnershipMarker {
  if (!isResourceKind(input.resourceKind)) {
    throw new Error('Invalid ownership marker resource kind.');
  }
  return {
    accountId: requiredString(input.accountId, 'ownership accountId'),
    installationId: requiredString(input.installationId, 'ownership installationId'),
    ownershipNonce: requiredString(input.ownershipNonce, 'ownership ownershipNonce'),
    resourceId: requiredString(input.resourceId, 'ownership resourceId'),
    resourceKey: requiredString(input.resourceKey, 'ownership resourceKey'),
    resourceKind: input.resourceKind,
    resourceName: requiredString(input.resourceName, 'ownership resourceName'),
    schemaVersion: PLATFORM_RESOURCE_OWNERSHIP_SCHEMA_VERSION,
  };
}

export function parsePlatformResourceOwnershipMarker(
  value: unknown,
): PlatformResourceOwnershipMarker {
  assertRecord(value, 'Platform resource ownership marker');
  if (value.schemaVersion !== PLATFORM_RESOURCE_OWNERSHIP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported platform resource ownership schema version: ${String(value.schemaVersion)}.`,
    );
  }
  // The constructor validates every field.
  return createPlatformResourceOwnershipMarker(
    value as Parameters<typeof createPlatformResourceOwnershipMarker>[0],
  );
}

export function createPlatformInstallationManifest(input: {
  account: { id: string; name: string };
  createdAt: string;
  deployment: PlatformDeploymentManifest;
  deploymentExecution?: 1;
  id: string;
  ownershipNonce: string;
  platformVersion: string;
  safetyProtocols?: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>;
  usageProtocolVersion?: 0 | 1 | 2;
}): PlatformInstallationManifest {
  const createdAt = assertTimestamp(input.createdAt, 'createdAt');
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(input.id)) {
    throw new Error('Installation id must be a lowercase identifier between 8 and 80 characters.');
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.ownershipNonce)) {
    throw new Error('Ownership nonce must contain 32 to 128 URL-safe characters.');
  }
  return {
    account: {
      id: requiredString(input.account.id, 'account.id'),
      name: requiredString(input.account.name, 'account.name'),
    },
    createdAt,
    databaseSchemaDigest: null,
    ...(input.deploymentExecution === 1 ? { deploymentExecution: 1 as const } : {}),
    deployment: parsePlatformDeploymentManifest(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Normalize the deployment manifest to its persisted JSON representation.
      JSON.parse(JSON.stringify(input.deployment)) as unknown,
    ),
    desiredState: 'enabled',
    endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
    id: input.id,
    ownershipNonce: input.ownershipNonce,
    platformVersion: requiredString(input.platformVersion, 'platformVersion'),
    resources: [],
    runtime: null,
    safetyProtocols: input.safetyProtocols ?? { sandboxDrain: 0 },
    schemaVersion: PLATFORM_INSTALLATION_SCHEMA_VERSION,
    status: 'draft',
    steps: [],
    updatedAt: createdAt,
    usageProtocolVersion: input.usageProtocolVersion ?? 0,
  };
}

export function setInstallationDesiredState(
  manifest: PlatformInstallationManifest,
  desiredState: PlatformInstallationManifest['desiredState'],
  updatedAt: string,
): PlatformInstallationManifest {
  return { ...manifest, desiredState, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

function normalizeEndpoint(value: string | null, label: string): string | null {
  if (value === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL or null.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

export function setInstallationEndpoints(
  manifest: PlatformInstallationManifest,
  endpoints: PlatformInstallationEndpoints,
  updatedAt: string,
): PlatformInstallationManifest {
  return {
    ...manifest,
    endpoints: {
      apiUrl: normalizeEndpoint(endpoints.apiUrl, 'endpoints.apiUrl'),
      dashboardUrl: normalizeEndpoint(endpoints.dashboardUrl, 'endpoints.dashboardUrl'),
      proxyUrl: normalizeEndpoint(endpoints.proxyUrl, 'endpoints.proxyUrl'),
    },
    updatedAt: assertTimestamp(updatedAt, 'updatedAt'),
  };
}

export function transitionInstallation(
  manifest: PlatformInstallationManifest,
  status: InstallationStatus,
  updatedAt: string,
): PlatformInstallationManifest {
  if (status !== manifest.status && !STATUS_TRANSITIONS[manifest.status].includes(status)) {
    throw new Error(`Invalid installation transition: ${manifest.status} -> ${status}.`);
  }
  return { ...manifest, status, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function recordInstallationResource(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  updatedAt: string,
): PlatformInstallationManifest {
  requiredString(resource.key, 'resource.key');
  requiredString(resource.id, 'resource.id');
  requiredString(resource.name, 'resource.name');
  requiredString(resource.configHash, 'resource.configHash');
  const collision = manifest.resources.find(
    (entry) =>
      entry.key !== resource.key && entry.kind === resource.kind && entry.id === resource.id,
  );
  if (collision) {
    throw new Error(`Resource id ${resource.id} is already owned by ${collision.key}.`);
  }
  const resources = manifest.resources.filter((entry) => entry.key !== resource.key);
  resources.push({ ...resource });
  resources.sort((left, right) => left.key.localeCompare(right.key));
  return { ...manifest, resources, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function recordInstallationStep(
  manifest: PlatformInstallationManifest,
  step: InstallationStep,
  updatedAt: string,
): PlatformInstallationManifest {
  requiredString(step.key, 'step.key');
  requiredString(step.resultHash, 'step.resultHash');
  assertTimestamp(step.completedAt, 'step.completedAt');
  const existing = manifest.steps.find((entry) => entry.key === step.key);
  if (existing && existing.resultHash !== step.resultHash) {
    throw new Error(`Completed installation step ${step.key} has a different result.`);
  }
  const steps = existing ? manifest.steps : [...manifest.steps, { ...step }];
  return { ...manifest, steps, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function parsePlatformInstallationManifest(value: unknown): PlatformInstallationManifest {
  assertRecord(value, 'Platform installation manifest');
  if (value.schemaVersion !== PLATFORM_INSTALLATION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported platform installation schema version: ${String(value.schemaVersion)}.`,
    );
  }
  const account = value.account;
  const endpoints = value.endpoints;
  assertRecord(account, 'account');
  if (value.deploymentExecution !== undefined && value.deploymentExecution !== 1) {
    throw new Error('Unsupported deployment execution protocol.');
  }
  assertRecord(endpoints, 'endpoints');
  if (!isInstallationStatus(value.status)) {
    throw new Error(`Invalid installation status: ${String(value.status)}.`);
  }
  if (!Array.isArray(value.resources)) {
    throw new Error('resources must be an array.');
  }
  if (!Array.isArray(value.steps)) {
    throw new Error('steps must be an array.');
  }
  const manifest = createPlatformInstallationManifest({
    account: {
      id: requiredString(account.id, 'account.id'),
      name: requiredString(account.name, 'account.name'),
    },
    createdAt: requiredString(value.createdAt, 'createdAt'),
    deployment: parsePlatformDeploymentManifest(value.deployment),
    ...(value.deploymentExecution === 1 ? { deploymentExecution: 1 as const } : {}),
    id: requiredString(value.id, 'id'),
    ownershipNonce: requiredString(value.ownershipNonce, 'ownershipNonce'),
    platformVersion: requiredString(value.platformVersion, 'platformVersion'),
    safetyProtocols: parseSafetyProtocols(value.safetyProtocols),
    usageProtocolVersion: parseUsageProtocolVersion(value.usageProtocolVersion),
  });
  const runtime = parsePlatformRuntimeProvenance(value.runtime);
  let pendingDomain: PlatformDeploymentManifest['application'] | undefined;
  if (value.pendingDomain !== undefined) {
    assertRecord(value.pendingDomain, 'pendingDomain');
    pendingDomain = createPlatformDeploymentManifest({
      ...manifest.deployment,
      application: value.pendingDomain as PlatformDeploymentManifest['application'],
    }).application;
    if (
      !manifest.deployment.application.workersDev ||
      !pendingDomain.zoneName ||
      JSON.stringify(pendingDomain.workersDev) !==
        JSON.stringify(manifest.deployment.application.workersDev)
    ) {
      throw new Error('Pending domain must retain the installation workers.dev identity.');
    }
  }
  const updatedAt = assertTimestamp(requiredString(value.updatedAt, 'updatedAt'), 'updatedAt');
  let next: PlatformInstallationManifest = setInstallationEndpoints(
    {
      ...manifest,
      desiredState:
        value.desiredState === 'disabled' || value.desiredState === 'enabled'
          ? value.desiredState
          : value.status === 'disabled' || value.status === 'disabling'
            ? 'disabled'
            : 'enabled',
      status: value.status,
      runtime,
      ...(value.operation !== undefined
        ? { operation: parsePlatformLifecycleOperation(value.operation) }
        : {}),
      ...(pendingDomain ? { pendingDomain } : {}),
      ...(value.authenticationResources !== undefined
        ? { authenticationResources: parseAuthenticationResources(value.authenticationResources) }
        : {}),
      updatedAt,
    },
    {
      apiUrl:
        endpoints.apiUrl === null ? null : requiredString(endpoints.apiUrl, 'endpoints.apiUrl'),
      dashboardUrl:
        endpoints.dashboardUrl === null
          ? null
          : requiredString(endpoints.dashboardUrl, 'endpoints.dashboardUrl'),
      proxyUrl:
        endpoints.proxyUrl === null
          ? null
          : requiredString(endpoints.proxyUrl, 'endpoints.proxyUrl'),
    },
    updatedAt,
  );
  for (const [index, entry] of value.resources.entries()) {
    assertRecord(entry, `resources[${index}]`);
    if (!isResourceKind(entry.kind)) {
      throw new Error(`Invalid resources[${index}].kind.`);
    }
    if (!isOwnership(entry.ownership)) {
      throw new Error(`Invalid resources[${index}].ownership.`);
    }
    if (!isResourceState(entry.state)) {
      throw new Error(`Invalid resources[${index}].state.`);
    }
    next = recordInstallationResource(
      next,
      {
        configHash: requiredString(entry.configHash, `resources[${index}].configHash`),
        id: requiredString(entry.id, `resources[${index}].id`),
        key: requiredString(entry.key, `resources[${index}].key`),
        kind: entry.kind,
        name: requiredString(entry.name, `resources[${index}].name`),
        ownership: entry.ownership,
        state: entry.state,
      },
      next.updatedAt,
    );
  }
  for (const [index, entry] of value.steps.entries()) {
    assertRecord(entry, `steps[${index}]`);
    next = recordInstallationStep(
      next,
      {
        completedAt: requiredString(entry.completedAt, `steps[${index}].completedAt`),
        key: requiredString(entry.key, `steps[${index}].key`),
        resultHash: requiredString(entry.resultHash, `steps[${index}].resultHash`),
      },
      next.updatedAt,
    );
  }
  const recordedDatabaseSchemaDigest =
    value.databaseSchemaDigest === undefined || value.databaseSchemaDigest === null
      ? ([...next.steps].reverse().find((step) => step.key.startsWith('database-schema:'))
          ?.resultHash ?? null)
      : requiredString(value.databaseSchemaDigest, 'databaseSchemaDigest');
  return { ...next, databaseSchemaDigest: recordedDatabaseSchemaDigest, updatedAt };
}

function parseAuthenticationResources(
  value: unknown,
): NonNullable<PlatformInstallationManifest['authenticationResources']> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Invalid authentication resource inventory.');
  }
  const resources = value.map(
    (entry): NonNullable<PlatformInstallationManifest['authenticationResources']>[number] => {
      assertRecord(entry, 'Authentication resource');
      if (
        (entry.kind !== 'application' && entry.kind !== 'service-token') ||
        (entry.ownership !== 'created' && entry.ownership !== 'adopted')
      ) {
        throw new Error('Invalid authentication resource kind or ownership.');
      }
      return {
        key: requiredString(entry.key, 'authentication resource key'),
        kind: entry.kind,
        accountId: requiredString(entry.accountId, 'authentication resource account'),
        id: requiredString(entry.id, 'authentication resource ID'),
        name: requiredString(entry.name, 'authentication resource name'),
        ownership: entry.ownership,
      };
    },
  );
  if (
    new Set(resources.map((resource) => `${resource.accountId}:${resource.kind}:${resource.id}`))
      .size !== resources.length
  ) {
    throw new Error('Duplicate authentication resource identity.');
  }
  return resources;
}

export function parseUsageProtocolVersion(value: unknown): 0 | 1 | 2 {
  if (value === undefined) {
    return 0;
  }
  if (!isUsageProtocolVersion(value)) {
    throw new Error('usageProtocolVersion must be 0, 1, or 2.');
  }
  return value;
}

function parseSafetyProtocols(value: unknown): PlatformInstallationManifest['safetyProtocols'] {
  if (value === undefined) {
    return { sandboxDrain: 0 };
  }
  assertRecord(value, 'safetyProtocols');
  if (!isSandboxDrainProtocol(value.sandboxDrain)) {
    throw new Error('safetyProtocols.sandboxDrain must be 0, 1, 2, or 3.');
  }
  return { sandboxDrain: value.sandboxDrain };
}

function parsePlatformRuntimeProvenance(value: unknown): PlatformRuntimeProvenance | null {
  if (value === undefined || value === null) {
    return null;
  }
  assertRecord(value, 'runtime');
  if (value.source !== 'custom' && value.source !== 'package') {
    throw new Error('runtime.source must be custom or package.');
  }
  const manifestSha256 = requiredString(value.manifestSha256, 'runtime.manifestSha256');
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error('runtime.manifestSha256 must be a SHA-256 digest.');
  }
  const sourceRevision =
    value.sourceRevision === null || value.sourceRevision === undefined
      ? null
      : requiredString(value.sourceRevision, 'runtime.sourceRevision');
  if (sourceRevision !== null && !isSourceRevision(sourceRevision)) {
    throw new Error('runtime.sourceRevision is invalid.');
  }
  return { manifestSha256, source: value.source, sourceRevision };
}
