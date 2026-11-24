import { isPrintableText, record } from './validate.ts';

/** Installation-defined plan IDs are stable even when a display name changes. */
export type PlanId = string;
export type BuiltinPlanId = 'free' | 'solo' | 'pro' | 'sponsored' | 'custom';

export type PlanLimits = Readonly<{
  /** Max requests per month (0 = unlimited) */
  requestsPerMonth: number;
  /** Max CPU milliseconds per request (0 = unlimited) */
  cpuMsPerRequest: number;
  /** Highest cpuMs a project may request via its deploy manifest (0 = no ceiling) */
  maxCpuMsPerRequest: number;
  /** Max sub-requests per invocation (0 = unlimited) */
  subRequestsPerInvocation: number;
  /** Max deploys per day (0 = unlimited) */
  deploysPerDay: number;
  /** Max D1 storage in bytes (0 = unlimited) */
  d1StorageBytes: number;
  /** Max R2 storage in bytes (0 = unlimited) */
  r2StorageBytes: number;
  /** Max KV storage in bytes (0 = unlimited) */
  kvStorageBytes: number;
  /** Max AI neurons per month (0 = unlimited) */
  aiNeuronsPerMonth: number;
  /** Max retained deployment scripts (0 = unlimited) */
  retainedDeployments: number;
  /** Max container-runtime seconds per billing month (0 = unlimited) */
  sandboxRuntimeSecondsPerMonth: number;
  /** Max simultaneous live sandbox containers (0 = unlimited) */
  sandboxMaxConcurrentInstances: number;
  /** Max simultaneous in-flight deploy builds (0 = unlimited) */
  concurrentBuilds: number;
  /** Max wall-clock minutes per build before timeout (0 = unlimited) */
  buildTimeoutMinutes: number;
}>;

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<BuiltinPlanId, PlanLimits> = {
  free: {
    requestsPerMonth: 3_000_000,
    cpuMsPerRequest: 10,
    maxCpuMsPerRequest: 10,
    subRequestsPerInvocation: 50,
    deploysPerDay: 100,
    d1StorageBytes: 1 * GB,
    r2StorageBytes: 5 * GB,
    kvStorageBytes: 1 * GB,
    aiNeuronsPerMonth: 100_000,
    retainedDeployments: 1,
    // 0 = unlimited in PlanLimits convention, so 1 effectively disables sandbox for free users.
    sandboxRuntimeSecondsPerMonth: 1,
    sandboxMaxConcurrentInstances: 1,
    concurrentBuilds: 1,
    buildTimeoutMinutes: 10,
  },
  solo: {
    requestsPerMonth: 10_000_000,
    cpuMsPerRequest: 30,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 50,
    deploysPerDay: 500,
    d1StorageBytes: 5 * GB,
    r2StorageBytes: 25 * GB,
    kvStorageBytes: 5 * GB,
    aiNeuronsPerMonth: 300_000,
    retainedDeployments: 5,
    sandboxRuntimeSecondsPerMonth: 30 * 3600,
    sandboxMaxConcurrentInstances: 2,
    concurrentBuilds: 2,
    buildTimeoutMinutes: 15,
  },
  pro: {
    requestsPerMonth: 100_000_000,
    cpuMsPerRequest: 50,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 3000,
    d1StorageBytes: 10 * GB,
    r2StorageBytes: 100 * GB,
    kvStorageBytes: 25 * GB,
    aiNeuronsPerMonth: 500_000,
    retainedDeployments: 25,
    sandboxRuntimeSecondsPerMonth: 200 * 3600,
    sandboxMaxConcurrentInstances: 10,
    concurrentBuilds: 3,
    buildTimeoutMinutes: 15,
  },
  sponsored: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 50,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
    aiNeuronsPerMonth: 0,
    retainedDeployments: 0,
    sandboxRuntimeSecondsPerMonth: 0,
    sandboxMaxConcurrentInstances: 0,
    concurrentBuilds: 6,
    buildTimeoutMinutes: 20,
  },
  custom: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 0,
    maxCpuMsPerRequest: 0,
    subRequestsPerInvocation: 0,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
    aiNeuronsPerMonth: 0,
    retainedDeployments: 0,
    sandboxRuntimeSecondsPerMonth: 0,
    sandboxMaxConcurrentInstances: 0,
    concurrentBuilds: 0,
    buildTimeoutMinutes: 0,
  },
};

/** Build container for free plans: `standard-3` (2 vCPU / 8 GiB / 16 GB, `BuildManager`). */
export const BUILD_INSTANCE_FREE = 'standard-3';
/** Build container for paid plans: `standard-4` (4 vCPU / 12 GiB / 20 GB, `BuildManagerLarge`). */
export const BUILD_INSTANCE_LARGE = 'standard-4';

/** Container instance size used for a plan's deploy builds. */
export type BuildInstanceType = typeof BUILD_INSTANCE_FREE | typeof BUILD_INSTANCE_LARGE;

export const PLAN_EDITABLE_LIMIT_KEYS = [
  'requestsPerMonth',
  'cpuMsPerRequest',
  'maxCpuMsPerRequest',
  'subRequestsPerInvocation',
  'deploysPerDay',
  'aiNeuronsPerMonth',
  'retainedDeployments',
  'sandboxRuntimeSecondsPerMonth',
  'sandboxMaxConcurrentInstances',
  'concurrentBuilds',
  'buildTimeoutMinutes',
] as const;
export type EditablePlanLimit = (typeof PLAN_EDITABLE_LIMIT_KEYS)[number];
export type PlanLimitsPatch = Partial<Pick<PlanLimits, EditablePlanLimit>>;

export type PlatformPlanDefinition = Readonly<{
  id: PlanId;
  name: string;
  archived: boolean;
  limits: PlanLimits;
  buildInstanceType: BuildInstanceType;
  allowShortSlugs: boolean;
}>;
export type PlatformPlanReconciliation = Readonly<{
  revision: number;
  planIds: ReadonlyArray<PlanId>;
  cursor: string | null;
  complete: boolean;
  error?: Readonly<{ accountId: string; message: string }>;
}>;
export type PlatformPlanCatalog = Readonly<{
  revision: number;
  defaultPlanId: PlanId;
  plans: ReadonlyArray<PlatformPlanDefinition>;
  reconciliation: PlatformPlanReconciliation | null;
}>;

export function createDefaultPlanCatalog(
  defaultPlanId: BuiltinPlanId = 'free',
): PlatformPlanCatalog {
  return {
    revision: 0,
    defaultPlanId,
    plans: Object.entries(PLAN_LIMITS).map(([id, limits]) => ({
      id,
      name: id,
      archived: false,
      limits: { ...limits },
      buildInstanceType: id === 'free' ? BUILD_INSTANCE_FREE : BUILD_INSTANCE_LARGE,
      allowShortSlugs: id !== 'free',
    })),
    reconciliation: null,
  };
}

export function parsePlatformPlanId(value: unknown): PlanId {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(
      'Plan IDs must start with a lowercase letter and contain at most 64 lowercase letters, digits, or hyphens.',
    );
  }
  return value;
}

export function parsePlanName(value: unknown): string {
  if (!isPrintableText(value, 80)) {
    throw new Error('Plan names must contain 1 to 80 printable characters.');
  }
  return value.trim();
}

export function parsePlanLimitsPatch(value: unknown): PlanLimitsPatch {
  const input = record(value, 'Plan limits');
  for (const [key, limit] of Object.entries(input)) {
    if (!(PLAN_EDITABLE_LIMIT_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new Error('Unknown or unenforced plan limit: ' + key + '.');
    }
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(key + ' must be a nonnegative safe integer; 0 means unlimited.');
    }
  }
  if (typeof input.buildTimeoutMinutes === 'number' && input.buildTimeoutMinutes > 60) {
    throw new Error(
      'buildTimeoutMinutes must be between 0 and 60; builds have a 60-minute platform maximum.',
    );
  }
  return input;
}

function validatePlanLimitValues(limits: Record<string, unknown>): void {
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(key + ' must be a nonnegative safe integer.');
    }
  }
}

function validatePlanLimitBounds(limits: PlanLimits): void {
  if (limits.buildTimeoutMinutes > 60) {
    throw new Error(
      'buildTimeoutMinutes must be between 0 and 60; builds have a 60-minute platform maximum.',
    );
  }
  if (
    limits.maxCpuMsPerRequest !== 0 &&
    (limits.cpuMsPerRequest === 0 || limits.cpuMsPerRequest > limits.maxCpuMsPerRequest)
  ) {
    throw new Error(
      'cpuMsPerRequest must not exceed maxCpuMsPerRequest; an unlimited default requires an unlimited ceiling.',
    );
  }
}

export function validatePlanLimits(limits: PlanLimits): void {
  validatePlanLimitValues(limits);
  validatePlanLimitBounds(limits);
}

function assertCompletePlanLimits(limits: Record<string, unknown>): asserts limits is PlanLimits {
  const required = Object.keys(PLAN_LIMITS.free);
  const supplied = Object.keys(limits);
  if (supplied.length !== required.length || required.some((key) => !supplied.includes(key))) {
    throw new Error('Plan limits must contain all supported fields.');
  }
  validatePlanLimitValues(limits);
}

export function parseBuildInstanceType(value: unknown): BuildInstanceType {
  if (value !== BUILD_INSTANCE_FREE && value !== BUILD_INSTANCE_LARGE) {
    throw new Error('buildInstanceType must be standard-3 or standard-4.');
  }
  return value;
}

/** Strict saved-state validation: invalid configuration must not silently lift quotas. */
export function parsePlatformPlanCatalog(value: unknown): PlatformPlanCatalog {
  const input = record(value, 'Plan catalog');
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Invalid plan catalog revision.');
  }
  if (!Array.isArray(input.plans) || input.plans.length === 0 || input.plans.length > 100) {
    throw new Error('A plan catalog must contain between 1 and 100 plans.');
  }
  const ids = new Set<string>();
  const plans = input.plans.map((value) => {
    const plan = record(value, 'Plan');
    const id = parsePlatformPlanId(plan.id);
    if (ids.has(id)) {
      throw new Error('Duplicate plan ID: ' + id + '.');
    }
    ids.add(id);
    if (typeof plan.archived !== 'boolean') {
      throw new Error('archived must be a boolean.');
    }
    if (typeof plan.allowShortSlugs !== 'boolean') {
      throw new Error('allowShortSlugs must be a boolean.');
    }
    const limits = record(plan.limits, 'Plan limits');
    assertCompletePlanLimits(limits);
    validatePlanLimitBounds(limits);
    return {
      id,
      name: parsePlanName(plan.name),
      archived: plan.archived,
      limits,
      buildInstanceType: parseBuildInstanceType(plan.buildInstanceType),
      allowShortSlugs: plan.allowShortSlugs,
    };
  });
  const defaultPlanId = parsePlatformPlanId(input.defaultPlanId);
  if (!plans.some((plan) => plan.id === defaultPlanId && !plan.archived)) {
    throw new Error('The default plan must exist and be active.');
  }
  let reconciliation: PlatformPlanReconciliation | null = null;
  if (input.reconciliation !== null) {
    const operation = record(input.reconciliation, 'Plan reconciliation');
    if (
      operation.revision !== revision ||
      typeof operation.complete !== 'boolean' ||
      !(operation.cursor === null || typeof operation.cursor === 'string') ||
      !Array.isArray(operation.planIds) ||
      operation.planIds.length > 100
    ) {
      throw new Error('Invalid plan reconciliation state.');
    }
    const planIds = operation.planIds.map(parsePlatformPlanId);
    if (planIds.some((id) => !ids.has(id))) {
      throw new Error('A reconciliation plan is missing.');
    }
    let error: PlatformPlanReconciliation['error'];
    if (operation.error !== undefined) {
      const failure = record(operation.error, 'Plan reconciliation failure');
      if (
        typeof failure.accountId !== 'string' ||
        typeof failure.message !== 'string' ||
        failure.message.length > 1000
      ) {
        throw new Error('Invalid plan reconciliation failure.');
      }
      error = { accountId: failure.accountId, message: failure.message };
    }
    reconciliation = {
      revision,
      complete: operation.complete,
      cursor: operation.cursor,
      planIds,
      ...(error ? { error } : {}),
    };
  }
  return { revision, defaultPlanId, plans, reconciliation };
}
