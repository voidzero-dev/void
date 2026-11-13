import { describe, expect, it } from 'vite-plus/test';
import { AI_LOGGING_SETTLE_MS, aiLoggingState } from '../../src/ai-logging.ts';

const at = 1_700_000_000_000;

function state(
  effective: Parameters<typeof aiLoggingState>[0]['effective'],
  published: Parameters<typeof aiLoggingState>[0]['published'],
  options: {
    now?: number;
    source?: 'project' | 'plan' | 'gateway';
    planPublishPending?: boolean;
    clearedAt?: number | null;
  } = {},
) {
  return aiLoggingState({
    effective,
    source: options.source ?? 'project',
    planPublishPending: options.planPublishPending ?? false,
    published,
    clearedAt: options.clearedAt ?? null,
    now: options.now ?? at + AI_LOGGING_SETTLE_MS,
  });
}

describe('AI logging readback state', () => {
  it('is pending until the settle time passes, then applied', () => {
    const key = { value: 'off', metadata: { mode: 'off', at } };
    expect(state('off', key, { now: at + 1 })).toEqual({
      published: 'off',
      publishedAt: at,
      state: 'pending',
    });
    expect(state('off', key)).toEqual({ published: 'off', publishedAt: at, state: 'applied' });
  });

  it('treats a missing key as published inherit', () => {
    expect(state('inherit', { value: null, metadata: null }, { source: 'gateway' })).toEqual({
      published: 'inherit',
      publishedAt: null,
      state: 'applied',
    });
    expect(state('off', { value: null, metadata: null }).state).toBe('drift');
  });

  it('is pending after a removed key until the settle time passes, then applied', () => {
    const removed = { value: null, metadata: null };
    expect(state('inherit', removed, { source: 'gateway', clearedAt: at, now: at + 1 })).toEqual({
      published: 'inherit',
      publishedAt: at,
      state: 'pending',
    });
    expect(state('inherit', removed, { source: 'gateway', clearedAt: at })).toEqual({
      published: 'inherit',
      publishedAt: null,
      state: 'applied',
    });
    // A marker never hides a key that should be there.
    expect(state('off', removed, { clearedAt: at, now: at + 1 }).state).toBe('drift');
  });

  it('reports drift for a wrong value, missing metadata or an unknown value', () => {
    expect(state('off', { value: 'full', metadata: { mode: 'full', at } }).state).toBe('drift');
    expect(state('off', { value: 'off', metadata: null }).state).toBe('drift');
    expect(state('off', { value: 'off', metadata: { mode: 'full', at } }).state).toBe('drift');
    expect(state('off', { value: 'bogus', metadata: null })).toMatchObject({
      published: null,
      state: 'drift',
    });
  });

  it('blames a running plan publish only when the project has no override', () => {
    const stale = { value: null, metadata: null };
    expect(state('off', stale, { source: 'plan', planPublishPending: true }).state).toBe(
      'pending_plan_publish',
    );
    expect(
      state(
        'inherit',
        { value: 'off', metadata: { mode: 'off', at } },
        {
          source: 'gateway',
          planPublishPending: true,
        },
      ).state,
    ).toBe('pending_plan_publish');
    expect(state('off', stale, { source: 'project', planPublishPending: true }).state).toBe(
      'drift',
    );
  });

  it('is unknown when the key could not be read', () => {
    expect(state('off', null)).toEqual({ published: null, publishedAt: null, state: 'unknown' });
  });
});
