import { describe, expect, it } from 'vite-plus/test';
import { isEqualFormValue } from '../../src/pages/form-value-equality.ts';

describe('isEqualFormValue (shared by every useForm adapter)', () => {
  it.each([
    ['equal strings', 'name', 'name', true],
    ['different strings', 'name', 'other', false],
    ['NaN', Number.NaN, Number.NaN, true],
    ['signed zero', -0, 0, false],
    ['null and undefined', null, undefined, false],
    ['equal nested arrays', ['one', { count: 2 }], ['one', { count: 2 }], true],
    ['different array lengths', ['one'], ['one', 'two'], false],
    ['different nested values', { flags: [true] }, { flags: [false] }, false],
    ['object key order', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ['different object keys', { a: undefined }, { b: undefined }, false],
    ['missing object key', {}, { a: undefined }, false],
    ['array and object', ['one'], { 0: 'one' }, false],
    ['different Date instances', new Date(0), new Date(0), false],
    ['plain object and Date', {}, new Date(0), false],
  ])('%s', (_name, left, right, equal) => {
    expect(isEqualFormValue(left, right)).toBe(equal);
    expect(isEqualFormValue(right, left)).toBe(equal);
  });

  it('compares non-plain values by reference', () => {
    const value = new Date(0);
    expect(isEqualFormValue(value, value)).toBe(true);
  });

  it('compares null-prototype records structurally', () => {
    const record = Object.assign(Object.create(null), { enabled: true });
    expect(isEqualFormValue(record, { enabled: true })).toBe(true);
  });
});
