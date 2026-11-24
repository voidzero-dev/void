import { describe, expect, it } from 'vite-plus/test';
import { canonicalJson } from '../../src/index.ts';

describe('canonicalJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(
      canonicalJson({
        z: 1,
        a: { b: true, a: 'x' },
        list: [{ y: 2, x: 1 }, 'tail'],
      }),
    ).toBe('{"a":{"a":"x","b":true},"list":[{"x":1,"y":2},"tail"],"z":1}');
  });

  it('omits undefined object fields and preserves JSON string escaping', () => {
    expect(canonicalJson({ b: undefined, a: 'quote " slash \\\\ newline\n' })).toBe(
      String.raw`{"a":"quote \" slash \\\\ newline\n"}`,
    );
  });

  it('throws for unsupported values instead of silently hashing them', () => {
    expect(() => canonicalJson(undefined)).toThrow('Unsupported canonical JSON value');
    expect(() => canonicalJson({ a: () => undefined })).toThrow('Unsupported canonical JSON value');
  });
});
