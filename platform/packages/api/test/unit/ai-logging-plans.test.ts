import { createDefaultPlanCatalog } from '@void/platform/plans';
import { describe, expect, test } from 'vite-plus/test';
import { planAiLoggingChanges, startPlanAiLoggingPublish } from '../../src/ai-logging-plans.ts';
import { proposePlanAiLogging } from '../../src/operator/plans.ts';

const catalog = createDefaultPlanCatalog('free');
const withPlan = (id: string) => ({
  ...catalog,
  plans: [...catalog.plans, { ...catalog.plans[0]!, id, name: id }],
});

describe('plan AI logging changes', () => {
  test('a plan default change touches that plan, and unknown plans when it is the default', () => {
    expect(
      planAiLoggingChanges({
        before: catalog,
        after: catalog,
        modesBefore: {},
        modesAfter: { pro: 'off' },
      }),
    ).toEqual({ planIds: ['pro'], includeUnknown: false });
    expect(
      planAiLoggingChanges({
        before: catalog,
        after: catalog,
        modesBefore: { free: 'off' },
        modesAfter: {},
      }),
    ).toEqual({ planIds: ['free'], includeUnknown: true });
  });

  test('a default plan change reaches only accounts on unknown plans', () => {
    expect(
      planAiLoggingChanges({
        before: catalog,
        after: { ...catalog, defaultPlanId: 'pro' },
        modesBefore: { pro: 'off' },
        modesAfter: { pro: 'off' },
      }),
    ).toEqual({ planIds: [], includeUnknown: true });
    expect(
      planAiLoggingChanges({
        before: catalog,
        after: { ...catalog, defaultPlanId: 'pro' },
        modesBefore: {},
        modesAfter: {},
      }),
    ).toEqual({ planIds: [], includeUnknown: false });
  });

  test('a removed plan moves its accounts to the replacement default', () => {
    const before = withPlan('team');
    expect(
      planAiLoggingChanges({
        before,
        after: catalog,
        modesBefore: { team: 'off' },
        modesAfter: {},
        moved: { from: 'team', to: 'pro' },
      }),
    ).toEqual({ planIds: ['pro'], includeUnknown: false });
  });

  test('adding a plan reaches accounts already holding that plan ID', () => {
    expect(
      planAiLoggingChanges({
        before: catalog,
        after: withPlan('legacy-x'),
        modesBefore: { free: 'off' },
        modesAfter: { free: 'off' },
      }),
    ).toEqual({ planIds: ['legacy-x'], includeUnknown: false });
  });

  test('a new publish folds into one that has not finished and starts again', () => {
    const running = {
      revision: 3,
      planIds: ['pro'],
      includeUnknown: false,
      cursor: 'proj_b',
      complete: false,
    };
    expect(
      startPlanAiLoggingPublish(running, 4, { planIds: ['free'], includeUnknown: true }),
    ).toEqual({
      revision: 4,
      planIds: ['free', 'pro'],
      includeUnknown: true,
      cursor: null,
      complete: false,
    });
    const done = { ...running, complete: true };
    expect(startPlanAiLoggingPublish(done, 4, { planIds: [], includeUnknown: false })).toBe(done);
    expect(startPlanAiLoggingPublish(null, 4, { planIds: [], includeUnknown: false })).toBeNull();
  });
});

describe('plan AI logging defaults on plan edits', () => {
  test('set changes one plan, inherit clears and leaving it out keeps it', () => {
    expect(proposePlanAiLogging({}, 'set', 'pro', { aiLogging: 'off' }, undefined)).toEqual({
      pro: 'off',
    });
    expect(
      proposePlanAiLogging({ pro: 'off' }, 'set', 'pro', { aiLogging: 'inherit' }, undefined),
    ).toEqual({});
    expect(proposePlanAiLogging({ pro: 'off' }, 'set', 'pro', { name: 'Pro' }, undefined)).toEqual({
      pro: 'off',
    });
  });

  test('add copies the source plan unless the body sets it, and remove drops it', () => {
    expect(
      proposePlanAiLogging(
        { pro: 'metadata' },
        'add',
        undefined,
        { id: 'team', copyFrom: 'pro' },
        undefined,
      ),
    ).toEqual({ pro: 'metadata', team: 'metadata' });
    expect(
      proposePlanAiLogging(
        { pro: 'metadata' },
        'add',
        undefined,
        { id: 'team', copyFrom: 'pro', aiLogging: 'inherit' },
        undefined,
      ),
    ).toEqual({ pro: 'metadata' });
    expect(proposePlanAiLogging({ pro: 'off' }, 'remove', 'pro', {}, 'pro')).toEqual({});
  });

  test('refuses a bad mode and aiLogging on other actions', () => {
    expect(() => proposePlanAiLogging({}, 'set', 'pro', { aiLogging: 'all' }, undefined)).toThrow(
      'aiLogging must be one of',
    );
    expect(() =>
      proposePlanAiLogging({}, 'archive', 'pro', { aiLogging: 'off' }, undefined),
    ).toThrow('only when adding or editing');
  });
});
