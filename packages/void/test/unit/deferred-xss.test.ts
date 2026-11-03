import { describe, it, expect } from 'vite-plus/test';
import { safeJsonStringify } from '../../src/pages/protocol.ts';
import { islandFrontmatterScript, serializePageData } from '../../src/pages/serialize.ts';

describe.each([
  ['serializePageData', serializePageData],
  ['safeJsonStringify', safeJsonStringify],
])('%s inline-script escaping', (_name, serialize) => {
  it('escapes </script> so the inline script tag cannot be closed early', () => {
    const payload = { html: '</script><script>alert(1)</script>' };
    const out = serialize(payload);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).toContain('\\u003c/script\\u003e');
    expect(JSON.parse(out)).toEqual(payload);
  });

  it('escapes <, >, &, U+2028 and U+2029 and still round-trips', () => {
    const payload = {
      html: '<img onerror=alert(1)>',
      amp: 'a & b',
      ls: 'a\u2028b',
      ps: 'a\u2029b',
      count: 42,
      nested: { ok: true },
    };
    const out = serialize(payload);
    for (const char of ['<', '>', '&', '\u2028', '\u2029']) {
      expect(out).not.toContain(char);
    }
    expect(out).toContain('\\u0026');
    expect(JSON.parse(out)).toEqual(payload);
  });
});

describe('safeJsonStringify', () => {
  it.each([
    ['undefined', undefined],
    ['a function', () => {}],
  ])('returns null for %s', (_label, value) => {
    expect(safeJsonStringify(value)).toBe('null');
  });
});

describe('islandFrontmatterScript', () => {
  it('keeps a frontmatter value from closing the script tag', () => {
    const script = islandFrontmatterScript({ title: '</script><script>alert(1)</script>' });

    expect(script.indexOf('</script>')).toBe(script.length - '</script>'.length);
    expect(JSON.parse(script.slice(script.indexOf('>') + 1, -'</script>'.length))).toEqual({
      title: '</script><script>alert(1)</script>',
    });
  });

  it('is empty without frontmatter', () => {
    expect(islandFrontmatterScript(undefined)).toBe('');
    expect(islandFrontmatterScript({})).toBe('');
  });
});
