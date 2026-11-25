import { describe, expect, test } from 'vite-plus/test';
import {
  BUILD_INSTANCE_FREE,
  BUILD_INSTANCE_LARGE,
  createDefaultPlanCatalog,
  parsePlanLimitsPatch,
  parsePlatformPlanCatalog,
  parsePlatformPlanId,
  PLAN_EDITABLE_LIMIT_KEYS,
  PLAN_LIMITS,
  validatePlanLimits,
} from '../../src/plans.ts';

describe('installation plan contract', () => {
  test('preserves every existing built-in plan and its exact default limits', () => {
    const catalog = createDefaultPlanCatalog();
    expect(catalog.defaultPlanId).toBe('free');
    expect(catalog.plans.map((plan) => plan.id)).toEqual([
      'free',
      'solo',
      'pro',
      'sponsored',
      'custom',
    ]);
    expect(catalog.plans.map((plan) => plan.limits)).toEqual(Object.values(PLAN_LIMITS));
    expect(PLAN_LIMITS.free).toEqual({
      requestsPerMonth: 3_000_000,
      cpuMsPerRequest: 10,
      maxCpuMsPerRequest: 10,
      subRequestsPerInvocation: 50,
      deploysPerDay: 100,
      d1StorageBytes: 1024 ** 3,
      r2StorageBytes: 5 * 1024 ** 3,
      kvStorageBytes: 1024 ** 3,
      aiNeuronsPerMonth: 100_000,
      retainedDeployments: 1,
      sandboxRuntimeSecondsPerMonth: 1,
      sandboxMaxConcurrentInstances: 1,
      concurrentBuilds: 1,
      buildTimeoutMinutes: 10,
    });
    expect(catalog.plans.map((plan) => plan.buildInstanceType)).toEqual([
      BUILD_INSTANCE_FREE,
      ...Array(4).fill(BUILD_INSTANCE_LARGE),
    ]);
    expect(createDefaultPlanCatalog('custom').defaultPlanId).toBe('custom');
    const limits = catalog.plans[0].limits as { requestsPerMonth: number };
    limits.requestsPerMonth = 2;
    expect(createDefaultPlanCatalog().plans[0].limits.requestsPerMonth).toBe(3_000_000);
  });

  test('accepts explicit unlimited and integer quotas but excludes unenforced storage', () => {
    expect(parsePlanLimitsPatch({ requestsPerMonth: 0, buildTimeoutMinutes: 42 })).toEqual({
      requestsPerMonth: 0,
      buildTimeoutMinutes: 42,
    });
    expect(PLAN_EDITABLE_LIMIT_KEYS).toHaveLength(11);
    expect(() => parsePlanLimitsPatch({ buildTimeoutMinutes: 61 })).toThrow(
      '60-minute platform maximum',
    );
    for (const key of ['d1StorageBytes', 'r2StorageBytes', 'kvStorageBytes', 'typo']) {
      expect(() => parsePlanLimitsPatch({ [key]: 2 })).toThrow('Unknown or unenforced');
    }
    for (const value of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
      expect(() => parsePlanLimitsPatch({ requestsPerMonth: value })).toThrow(
        'nonnegative safe integer',
      );
    }
  });

  test('uses stable bounded IDs and checks the CPU default against its ceiling', () => {
    expect(parsePlatformPlanId('team-42')).toBe('team-42');
    for (const id of ['Team', '3plan', 'a/b', 'a'.repeat(65), '__proto__']) {
      expect(() => parsePlatformPlanId(id)).toThrow('Plan IDs');
    }
    expect(() => validatePlanLimits({ ...PLAN_LIMITS.free, cpuMsPerRequest: 11 })).toThrow(
      'must not exceed',
    );
    expect(() => validatePlanLimits({ ...PLAN_LIMITS.free, cpuMsPerRequest: 0 })).toThrow(
      'unlimited ceiling',
    );
    expect(() =>
      validatePlanLimits({ ...PLAN_LIMITS.free, cpuMsPerRequest: 0, maxCpuMsPerRequest: 0 }),
    ).not.toThrow();
  });

  test('rejects corrupt saved limits, duplicate IDs, an archived default and stale reconciliation', () => {
    const catalog = createDefaultPlanCatalog();
    expect(parsePlatformPlanCatalog(catalog)).toEqual(catalog);
    expect(() =>
      parsePlatformPlanCatalog({ ...catalog, plans: [...catalog.plans, catalog.plans[0]] }),
    ).toThrow('Duplicate');
    expect(() =>
      parsePlatformPlanCatalog({
        ...catalog,
        plans: catalog.plans.map((plan) => ({ ...plan, archived: true })),
      }),
    ).toThrow('default plan');
    expect(() =>
      parsePlatformPlanCatalog({
        ...catalog,
        plans: [{ ...catalog.plans[0], limits: { requestsPerMonth: 0 } }],
      }),
    ).toThrow('all supported fields');
    expect(() =>
      parsePlatformPlanCatalog({
        ...catalog,
        reconciliation: { revision: 1, planIds: ['free'], cursor: null, complete: false },
      }),
    ).toThrow('reconciliation state');
    expect(() =>
      parsePlatformPlanCatalog({
        ...catalog,
        reconciliation: { revision: 0, planIds: ['missing'], cursor: null, complete: false },
      }),
    ).toThrow('missing');
  });
});
