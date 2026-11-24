import { describe, it, expect } from 'vite-plus/test';
import { applyHeaderRules, parseClearSiteData, sanitizeClearSiteData } from '../../src/headers.ts';
import type { HeaderRule } from '../../src/headers.ts';

describe('applyHeaderRules', () => {
  it('returns original response when no rules', () => {
    const original = new Response('body', {
      headers: { 'Content-Type': 'text/html' },
    });
    const result = applyHeaderRules(original, '/index.html');
    expect(result).toBe(original);
  });

  it('returns original response when rules is empty array', () => {
    const original = new Response('body');
    const result = applyHeaderRules(original, '/index.html', []);
    expect(result).toBe(original);
  });

  it('returns original response when no rules match', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const original = new Response('body');
    const result = applyHeaderRules(original, '/index.html', rules);
    expect(result).toBe(original);
  });

  it('applies matching rule headers', () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Frame-Options', 'DENY']] }];
    const original = new Response('body', {
      headers: { 'Content-Type': 'text/html' },
    });
    const result = applyHeaderRules(original, '/index.html', rules);
    expect(result).not.toBe(original);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Content-Type')).toBe('text/html');
  });

  it('overrides existing headers from matching rules', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/assets/*', headers: [['Cache-Control', 'public, max-age=31536000, immutable']] },
    ];
    const original = new Response('body', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const result = applyHeaderRules(original, '/assets/app.js', rules);
    expect(result.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('merges headers from multiple matching rules', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/assets/app.js', rules);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Cache-Control')).toBe('immutable');
  });

  it('last matching rule wins for same header name', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Cache-Control', 'no-cache']] },
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/assets/app.js', rules);
    expect(result.headers.get('Cache-Control')).toBe('immutable');
  });

  it('preserves response body and status', async () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Custom', 'value']] }];
    const original = new Response('hello', { status: 201 });
    const result = applyHeaderRules(original, '/test', rules);
    expect(result.status).toBe(201);
    expect(await result.text()).toBe('hello');
  });

  it('blocks Set-Cookie header', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Set-Cookie', 'session=abc123']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Set-Cookie')).toBeNull();
  });

  it('blocks set-cookie header (lowercase)', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['set-cookie', 'session=abc123']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('set-cookie')).toBeNull();
  });

  it('strips the cookies directive from Clear-Site-Data (cross-tenant)', () => {
    // On the shared *.void.app domain, Clear-Site-Data: "cookies" clears cookies
    // for the registrable domain and all subdomains — a cross-tenant attack.
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cookies"']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Clear-Site-Data')).toBeNull();
  });

  it('keeps safe Clear-Site-Data directives while stripping cookies (origin-scoped)', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cache", "cookies", "storage"']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Clear-Site-Data')).toBe('"cache", "storage"');
  });

  it('a later fully-stripped Clear-Site-Data rule discards an earlier rule (last match wins)', () => {
    // Both rules match /assets/app.js; the more specific rule sanitizes to
    // nothing, so it must clear the earlier rule's value rather than leave it.
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cache"']] },
      { pattern: '/assets/*', headers: [['Clear-Site-Data', '"cookies"']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/assets/app.js', rules);
    expect(result.headers.get('Clear-Site-Data')).toBeNull();
  });

  it('falls back to the origin Clear-Site-Data when the last matching rule is fully stripped', () => {
    // A stripped rule resets the header to the origin's own value, not to an
    // earlier rule's value (last match wins).
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cache"']] },
      { pattern: '/assets/*', headers: [['Clear-Site-Data', '"cookies"']] },
    ];
    const origin = new Response('body', {
      headers: { 'Clear-Site-Data': '"storage"' },
    });
    const result = applyHeaderRules(origin, '/assets/app.js', rules);
    expect(result.headers.get('Clear-Site-Data')).toBe('"storage"');
  });

  it('does not resurface an origin cookies directive when the last rule is stripped', () => {
    // The origin worker response itself carries "cookies"; the stripped-rule
    // fallback sanitizes the origin value too, so rule processing never re-emits
    // the cross-tenant cookie directive.
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cache"']] },
      { pattern: '/assets/*', headers: [['Clear-Site-Data', '"cookies"']] },
    ];
    const origin = new Response('body', {
      headers: { 'Clear-Site-Data': '"cookies"' },
    });
    const result = applyHeaderRules(origin, '/assets/app.js', rules);
    expect(result.headers.get('Clear-Site-Data')).toBeNull();
  });

  it('keeps only the safe part of the origin Clear-Site-Data on stripped-rule fallback', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Clear-Site-Data', '"cache"']] },
      { pattern: '/assets/*', headers: [['Clear-Site-Data', '"cookies"']] },
    ];
    const origin = new Response('body', {
      headers: { 'Clear-Site-Data': '"storage", "cookies"' },
    });
    const result = applyHeaderRules(origin, '/assets/app.js', rules);
    expect(result.headers.get('Clear-Site-Data')).toBe('"storage"');
  });

  it('allows Strict-Transport-Security header (per-domain, safe)', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Strict-Transport-Security', 'max-age=31536000']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('allows normal headers like X-Custom-Header', () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Custom-Header', 'hello']] }];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('X-Custom-Header')).toBe('hello');
  });

  it('allows Cache-Control and Content-Type headers', () => {
    const rules: Array<HeaderRule> = [
      {
        pattern: '/*',
        headers: [
          ['Cache-Control', 'public, max-age=3600'],
          ['Content-Type', 'text/plain'],
        ],
      },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(result.headers.get('Content-Type')).toBe('text/plain');
  });

  it('blocks only blocked headers while allowing others in same rule', () => {
    const rules: Array<HeaderRule> = [
      {
        pattern: '/*',
        headers: [
          ['X-Frame-Options', 'DENY'],
          ['Set-Cookie', 'evil=true'],
          ['Cache-Control', 'no-cache'],
        ],
      },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Set-Cookie')).toBeNull();
    expect(result.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('treats a whole-segment `:name` header rule as a literal — does NOT over-match (regression)', () => {
    // REGRESSION (3282937e): the shared matcher briefly anchored a whole-segment
    // `:name` to a single-segment wildcard, so a user header rule `/:batchGet`
    // applied its headers to EVERY single-segment path (`/foo`, `/about`, …).
    // Header rules are user-authored and `:` must stay literal, so `/:batchGet`
    // must match ONLY the literal `/:batchGet`, never `/foo`.
    const rules: Array<HeaderRule> = [{ pattern: '/:batchGet', headers: [['X-Leak', 'yes']] }];
    const unrelated = new Response('body');
    // `/foo` must NOT receive the rule's headers (response returned unchanged).
    const missed = applyHeaderRules(unrelated, '/foo', rules);
    expect(missed).toBe(unrelated);
    expect(missed.headers.get('X-Leak')).toBeNull();
    // The literal path still matches.
    const hit = applyHeaderRules(new Response('body'), '/:batchGet', rules);
    expect(hit.headers.get('X-Leak')).toBe('yes');
  });
});

describe('parseClearSiteData', () => {
  const directives = (value: string) => parseClearSiteData(value).map((m) => m.directive);

  it('parses a single quoted directive', () => {
    expect(parseClearSiteData('"cookies"')).toEqual([{ raw: '"cookies"', directive: 'cookies' }]);
  });

  it('parses a comma-separated list and trims surrounding whitespace', () => {
    expect(directives('"cache",  "storage" , "cookies"')).toEqual(['cache', 'storage', 'cookies']);
  });

  it('preserves the original case of the directive content', () => {
    expect(directives('"Cache"')).toEqual(['Cache']);
  });

  it('does not split on a comma inside a quoted-string', () => {
    const members = parseClearSiteData('"a,b", "cookies"');
    expect(members.map((m) => m.raw)).toEqual(['"a,b"', '"cookies"']);
    expect(members.map((m) => m.directive)).toEqual(['a,b', 'cookies']);
  });

  it('resolves quoted-pair escapes so an escaped form cannot hide a directive', () => {
    // RFC 7230 quoted-pair: \e is the literal "e", so this content IS "cookies".
    expect(directives(String.raw`"cooki\es"`)).toEqual(['cookies']);
  });

  it('marks members that are not well-formed quoted-strings as malformed', () => {
    expect(directives('cookies')).toEqual([null]); // unquoted
    expect(directives('"cookies')).toEqual([null]); // no closing quote
    expect(directives('"a"b"')).toEqual([null]); // unescaped inner quote
    expect(directives('"bad\\')).toEqual([null]); // dangling escape, no close
  });

  it('drops empty members', () => {
    expect(parseClearSiteData('')).toEqual([]);
    expect(directives('"cache", , "storage"')).toEqual(['cache', 'storage']);
  });
});

describe('sanitizeClearSiteData', () => {
  it('drops the cross-tenant cookies directive', () => {
    expect(sanitizeClearSiteData('"cookies"')).toBeNull();
  });

  it('drops the whole value for the "*" wildcard (it includes cookies)', () => {
    expect(sanitizeClearSiteData('"*"')).toBeNull();
    expect(sanitizeClearSiteData('"cache", "*"')).toBeNull();
  });

  it('keeps origin-scoped directives verbatim', () => {
    expect(sanitizeClearSiteData('"cache", "storage"')).toBe('"cache", "storage"');
    expect(sanitizeClearSiteData('"executionContexts"')).toBe('"executionContexts"');
  });

  it('keeps unknown but well-formed directives (forward-compatible)', () => {
    expect(sanitizeClearSiteData('"clientHints"')).toBe('"clientHints"');
  });

  it('strips only the cookies directive from a mixed value', () => {
    expect(sanitizeClearSiteData('"cache", "cookies", "storage"')).toBe('"cache", "storage"');
  });

  it('strips case-variant and escape-obfuscated cookies directives', () => {
    expect(sanitizeClearSiteData('"COOKIES"')).toBeNull();
    expect(sanitizeClearSiteData(String.raw`"cooki\es"`)).toBeNull(); // \e resolves to "cookies"
    expect(sanitizeClearSiteData('"cache", "Cookies"')).toBe('"cache"');
  });

  it('drops malformed members (a browser ignores them anyway)', () => {
    expect(sanitizeClearSiteData('cookies')).toBeNull(); // unquoted → malformed → dropped
    expect(sanitizeClearSiteData('"cache", garbage')).toBe('"cache"');
  });

  it('returns null for an empty or whitespace-only value', () => {
    expect(sanitizeClearSiteData('')).toBeNull();
    expect(sanitizeClearSiteData('   ')).toBeNull();
  });
});
