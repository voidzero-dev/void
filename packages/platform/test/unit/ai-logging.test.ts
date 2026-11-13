import { describe, expect, it } from 'vite-plus/test';
import {
  AI_LOGGING_MODES,
  isAiLoggingMode,
  isPublishedAiLoggingMode,
  parseAiLoggingKeyMetadata,
  parsePlanAiLoggingInput,
  parsePlanAiLoggingSettings,
  parsePublishedAiLogging,
  planAiLogging,
  planPublishPending,
  publishOrder,
  resolveAiLogging,
} from '../../src/ai-logging.ts';

describe('AI logging policy', () => {
  it('accepts exactly the four operator modes', () => {
    expect(AI_LOGGING_MODES).toEqual(['inherit', 'off', 'metadata', 'full']);
    for (const mode of AI_LOGGING_MODES) {
      expect(isAiLoggingMode(mode)).toBe(true);
    }
    for (const value of ['OFF', ' off', '', 'none', null, undefined, 0, false, {}]) {
      expect(isAiLoggingMode(value)).toBe(false);
    }
  });

  it('never stores inherit', () => {
    expect(isPublishedAiLoggingMode('inherit')).toBe(false);
    expect(['off', 'metadata', 'full'].every(isPublishedAiLoggingMode)).toBe(true);
  });

  it('reads a missing key as inherit and refuses values it does not know', () => {
    expect(parsePublishedAiLogging(null)).toBe('inherit');
    expect(parsePublishedAiLogging('off')).toBe('off');
    expect(parsePublishedAiLogging('metadata')).toBe('metadata');
    expect(parsePublishedAiLogging('full')).toBe('full');
    for (const value of ['inherit', '', 'OFF', 'off ', '"off"', 'future-mode']) {
      expect(parsePublishedAiLogging(value)).toBeUndefined();
    }
  });

  it('prefers the project override, then the plan default, then the gateway', () => {
    expect(resolveAiLogging('full', 'off')).toEqual({ mode: 'full', source: 'project' });
    expect(resolveAiLogging('off', 'full')).toEqual({ mode: 'off', source: 'project' });
    expect(resolveAiLogging(null, 'metadata')).toEqual({ mode: 'metadata', source: 'plan' });
    expect(resolveAiLogging('inherit', 'off')).toEqual({ mode: 'off', source: 'plan' });
    expect(resolveAiLogging(undefined, 'inherit')).toEqual({ mode: 'inherit', source: 'gateway' });
    expect(resolveAiLogging(null, null)).toEqual({ mode: 'inherit', source: 'gateway' });
  });

  it('orders known changes and treats any change with inherit as unknown', () => {
    expect(publishOrder('full', 'off')).toBe('tighten');
    expect(publishOrder('full', 'metadata')).toBe('tighten');
    expect(publishOrder('metadata', 'off')).toBe('tighten');
    expect(publishOrder('off', 'metadata')).toBe('loosen');
    expect(publishOrder('off', 'full')).toBe('loosen');
    expect(publishOrder('metadata', 'full')).toBe('loosen');
    for (const mode of AI_LOGGING_MODES) {
      expect(publishOrder(mode, mode)).toBe('same');
    }
    for (const mode of ['off', 'metadata', 'full'] as const) {
      expect(publishOrder('inherit', mode)).toBe('unknown');
      expect(publishOrder(mode, 'inherit')).toBe('unknown');
    }
  });

  it('reads key metadata and treats anything malformed as missing', () => {
    expect(parseAiLoggingKeyMetadata({ mode: 'off', at: 1700000000000 })).toEqual({
      mode: 'off',
      at: 1700000000000,
    });
    for (const value of [
      null,
      undefined,
      'off',
      [],
      { mode: 'inherit', at: 1 },
      { mode: 'off' },
      { mode: 'off', at: '1' },
      { mode: 'off', at: 1.5 },
    ]) {
      expect(parseAiLoggingKeyMetadata(value)).toBeNull();
    }
  });
});

describe('plan AI logging defaults', () => {
  const catalog = { defaultPlanId: 'free', plans: [{ id: 'free' }, { id: 'pro' }] };

  it('reads a missing row as every plan inheriting', () => {
    expect(parsePlanAiLoggingSettings(null)).toEqual({ modes: {}, publish: null });
    expect(planAiLogging(parsePlanAiLoggingSettings(null), catalog, 'pro')).toEqual({
      planId: 'pro',
      planKnown: true,
      defaultPlanId: 'free',
      planMode: null,
    });
  });

  it('keeps known modes, drops inherit and refuses modes it does not know', () => {
    const settings = parsePlanAiLoggingSettings({
      modes: { pro: 'metadata', free: 'inherit', gone: 'off' },
      publish: null,
    });
    expect(settings.modes).toEqual({ pro: 'metadata', gone: 'off' });
    for (const modes of [{ pro: 'OFF' }, { pro: null }, { pro: 1 }, []]) {
      expect(() => parsePlanAiLoggingSettings({ modes, publish: null })).toThrow();
    }
    expect(() => parsePlanAiLoggingSettings('off')).toThrow();
    expect(() =>
      parsePlanAiLoggingSettings({ modes: {}, publish: { planIds: 'pro', complete: false } }),
    ).toThrow();
  });

  it('ignores entries for plans that are no longer in the catalog', () => {
    const settings = parsePlanAiLoggingSettings({ modes: { gone: 'off' } });
    expect(planAiLogging(settings, catalog, 'free').planMode).toBeNull();
    expect(planAiLogging(settings, catalog, 'pro').planMode).toBeNull();
  });

  it('gives an account on an unknown plan the logging of the default plan', () => {
    const settings = parsePlanAiLoggingSettings({ modes: { free: 'off', pro: 'full' } });
    expect(planAiLogging(settings, catalog, 'legacy-x')).toEqual({
      planId: 'legacy-x',
      planKnown: false,
      defaultPlanId: 'free',
      planMode: 'off',
    });
    expect(planAiLogging(settings, catalog, 'pro').planMode).toBe('full');
  });

  it('knows which accounts a running plan publish still has to reach', () => {
    const publish = parsePlanAiLoggingSettings({
      modes: {},
      publish: {
        revision: 3,
        planIds: ['pro'],
        includeUnknown: true,
        cursor: null,
        complete: false,
      },
    }).publish!;
    expect(planPublishPending(publish, { planId: 'pro', planKnown: true })).toBe(true);
    expect(planPublishPending(publish, { planId: 'free', planKnown: true })).toBe(false);
    expect(planPublishPending(publish, { planId: 'legacy-x', planKnown: false })).toBe(true);
    expect(
      planPublishPending({ ...publish, complete: true }, { planId: 'pro', planKnown: true }),
    ).toBe(false);
    expect(planPublishPending(null, { planId: 'pro', planKnown: true })).toBe(false);
  });

  it('requires the catalog revision that started a publish', () => {
    const publish = { planIds: ['pro'], includeUnknown: false, cursor: null, complete: false };
    expect(() => parsePlanAiLoggingSettings({ modes: {}, publish })).toThrow();
    expect(
      parsePlanAiLoggingSettings({ modes: {}, publish: { ...publish, revision: 4, error: 'x' } })
        .publish,
    ).toEqual({ ...publish, revision: 4, error: 'x' });
  });

  it('reads a plan change: omitted keeps, inherit clears, anything else is refused', () => {
    expect(parsePlanAiLoggingInput(undefined)).toBeUndefined();
    for (const mode of AI_LOGGING_MODES) {
      expect(parsePlanAiLoggingInput(mode)).toBe(mode);
    }
    for (const value of [null, '', 'OFF', 'everything', 1]) {
      expect(() => parsePlanAiLoggingInput(value)).toThrow('aiLogging must be one of');
    }
  });
});
