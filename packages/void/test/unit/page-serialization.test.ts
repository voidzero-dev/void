import { describe, expect, it } from 'vite-plus/test';
import { normalizePageDataForJsonCache } from '../../../isr/src/core.ts';
import { deserializePageData, serializePageData } from '../../src/pages/serialize.ts';

describe('page serialization', () => {
  it('serializes rich page props and shared values without throwing', () => {
    const date = new Date('2026-11-08T00:00:00Z');
    const values = { date, map: new Map([['created', date]]), count: 42n };
    expect(() => serializePageData({ props: values, shared: values })).not.toThrow();
  });

  it('round-trips rich values, cycles, and shared references', () => {
    const date = new Date('2026-11-08T00:00:00Z');
    const values = {
      date,
      map: new Map([['created', date]]),
      set: new Set([date]),
      count: 42n,
      url: new URL('https://void.cloud/?q=hello'),
      regexp: /void/gi,
      missing: undefined,
      nan: NaN,
      infinity: Infinity,
      negativeZero: -0,
    };
    const page = { props: values, shared: values, self: null as unknown };
    page.self = page;
    const restored = deserializePageData<typeof page>(serializePageData(page));
    expect(restored).toEqual(page);
    expect(restored.self).toBe(restored);
    expect(restored.shared).toBe(restored.props);
    expect(restored.props.map.get('created')).toBe(restored.props.date);
    expect(restored.props.url.href).toBe(values.url.href);
    expect(Object.hasOwn(restored.props, 'missing')).toBe(true);
  });

  it('reads old cached JSON without interpreting application data as type tags', () => {
    const page = { component: 'home', props: { type: 'Date', value: '2026-11-08' } };
    expect(deserializePageData(JSON.stringify(page))).toEqual(page);
  });

  it('preserves application fields named deferred, including cycles', () => {
    const value = { deferred: { cycle: null as unknown } };
    value.deferred.cycle = value;
    expect(deserializePageData(serializePageData(value))).toEqual(value);
  });

  it('keeps incomplete deferred pages out of existing ISR JSON caches', () => {
    expect(
      normalizePageDataForJsonCache(serializePageData({ props: {}, deferred: ['stats'] })),
    ).toBeNull();
    expect(
      normalizePageDataForJsonCache(
        serializePageData({ props: {}, deferredKeys: { stats: 'stats' } }),
      ),
    ).toBeNull();
    const complete = serializePageData({ props: { date: new Date() } });
    expect(normalizePageDataForJsonCache(complete)).toBe(complete);
  });

  it('rejects functions and custom classes instead of silently dropping values', () => {
    expect(() => serializePageData({ fn() {} })).toThrow();
    expect(() => serializePageData({ instance: new (class Custom {})() })).toThrow();
  });
});
