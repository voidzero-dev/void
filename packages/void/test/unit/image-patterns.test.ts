import { describe, expect, it } from 'vite-plus/test';
import { compileLocalPattern, compileRemotePattern } from '../../src/image-config.ts';
import {
  hasLocalMatch,
  hasRemoteMatch,
  matchLocalPattern,
  matchRemotePattern,
  type LocalPattern,
  type RemotePattern,
} from '../../src/image/index.ts';

// Results verified against Next.js 16.4.2's compiled picomatch (v4).
describe('remote pattern globs (picomatch v4 parity)', () => {
  it.each([
    ['*.example.com', 'a.example.com', true],
    ['*.example.com', 'a.b.example.com', true],
    ['*.example.com', 'example.com', false],
    ['**.example.com', 'a.b.example.com', true],
    ['**.example.com', 'example.com', false],
    ['example.com', 'example.com', true],
    ['example.com', 'www.example.com', false],
    ['cdn-*.example.com', 'cdn-1.example.com', true],
  ] as Array<[string, string, boolean]>)('hostname %s vs %s is %s', (hostname, host, expected) => {
    const pattern = compileRemotePattern({ hostname });
    expect(matchRemotePattern(pattern, new URL(`https://${host}/a.png`))).toBe(expected);
  });

  it.each([
    ['/img/*', '/img/a.png', true],
    ['/img/*', '/img/a/b.png', false],
    ['/img/*', '/img/a.png/', true],
    ['/img/**', '/img', true],
    ['/img/**', '/img/', true],
    ['/img/**', '/img/a/b', true],
    ['/img/**', '/images/a', false],
    ['**', '/a/.b/c', true],
    ['/img/**/*.png', '/img/a/b.png', true],
    ['/img/**/*.png', '/img/a/b.jpg', false],
  ] as Array<[string, string, boolean]>)('pathname %s vs %s is %s', (pathname, path, expected) => {
    const pattern = compileRemotePattern({ hostname: 'example.com', pathname });
    expect(matchRemotePattern(pattern, new URL(`https://example.com${path}`))).toBe(expected);
    expect(matchLocalPattern(compileLocalPattern({ pathname }), new URL(path, 'http://n'))).toBe(
      expected,
    );
  });

  it('compiles ** with dot: true as Next.js does', () => {
    expect(compileLocalPattern({}).pathnameRe).toBe(
      String.raw`^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/?)$`,
    );
  });
});

describe('matchRemotePattern', () => {
  const url = new URL('https://cdn.example.com:8443/img/a.png?v=1');

  it.each([
    [{ hostname: 'cdn.example.com' }, true],
    [{ protocol: 'https', hostname: 'cdn.example.com' }, true],
    [{ protocol: 'http', hostname: 'cdn.example.com' }, false],
    [{ hostname: 'cdn.example.com', port: '8443' }, true],
    [{ hostname: 'cdn.example.com', port: '' }, false],
    [{ hostname: 'cdn.example.com', search: '?v=1' }, true],
    [{ hostname: 'cdn.example.com', search: '' }, false],
    [{ hostname: 'cdn.example.com', pathname: '/img/**' }, true],
    [{ hostname: 'cdn.example.com', pathname: '/other/**' }, false],
  ] as Array<[RemotePattern, boolean]>)('%j is %s', (pattern, expected) => {
    expect(matchRemotePattern(compileRemotePattern(pattern), url)).toBe(expected);
  });

  it('normalizes URL patterns like Next.js (port and search must be empty)', () => {
    const pattern = compileRemotePattern(new URL('https://example.com/account/**'));
    expect(pattern).toMatchObject({
      protocol: 'https',
      hostname: 'example.com',
      port: '',
      pathname: '/account/**',
      search: '',
    });
    expect(matchRemotePattern(pattern, new URL('https://example.com/account/a.png'))).toBe(true);
    expect(matchRemotePattern(pattern, new URL('https://example.com/account/a.png?x'))).toBe(false);
    expect(matchRemotePattern(pattern, new URL('https://example.com:8080/account/a.png'))).toBe(
      false,
    );
    expect(matchRemotePattern(pattern, new URL('http://example.com/account/a.png'))).toBe(false);
  });

  it('rejects protocols other than http and https', () => {
    expect(() => compileRemotePattern(new URL('ftp://example.com'))).toThrow(
      'Specified images.remotePatterns must have protocol "http" or "https" received "ftp".',
    );
  });
});

describe('hasRemoteMatch', () => {
  const patterns = [compileRemotePattern({ protocol: 'https', hostname: '**.example.com' })];

  it('matches domains by exact hostname or any pattern', () => {
    expect(hasRemoteMatch(['images.test'], [], new URL('https://images.test/a.png'))).toBe(true);
    expect(hasRemoteMatch(['images.test'], [], new URL('https://a.images.test/a.png'))).toBe(false);
    expect(hasRemoteMatch([], patterns, new URL('https://a.example.com/a.png'))).toBe(true);
    expect(hasRemoteMatch([], patterns, new URL('https://example.org/a.png'))).toBe(false);
  });
});

describe('hasLocalMatch', () => {
  const compile = (patterns: Array<LocalPattern>) => patterns.map(compileLocalPattern);

  it('allows every local path without patterns', () => {
    expect(hasLocalMatch(undefined, '/a.png?x=1')).toBe(true);
  });

  it('requires an empty query with the default pattern', () => {
    const patterns = compile([{ pathname: '**', search: '' }]);
    expect(hasLocalMatch(patterns, '/a/b.png')).toBe(true);
    expect(hasLocalMatch(patterns, '/a/b.png?v=1')).toBe(false);
  });

  it('matches search exactly and normalizes the path first', () => {
    const patterns = compile([{ pathname: '/img/**', search: '?v=1' }]);
    expect(hasLocalMatch(patterns, '/img/a.png?v=1')).toBe(true);
    expect(hasLocalMatch(patterns, '/img/a.png?v=2')).toBe(false);
    expect(hasLocalMatch(patterns, '/img/../secret.png?v=1')).toBe(false);
    expect(hasLocalMatch(patterns, '/other/../img/a.png?v=1')).toBe(true);
  });

  it('matches any search when the pattern has none', () => {
    const patterns = compile([{ pathname: '/img/**' }]);
    expect(hasLocalMatch(patterns, '/img/a.png?anything')).toBe(true);
  });
});
