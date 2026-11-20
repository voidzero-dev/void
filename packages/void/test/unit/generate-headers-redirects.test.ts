import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import { parseHeadersFile, parseRedirectsFile } from '../../src/cli/headers.ts';

const tmpDir = packageFixturePath(import.meta.dirname, '.tmp-parse-redirects-test');

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, '_redirects'), content);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseHeadersFile', () => {
  it('keeps header patterns with multiple anonymous splats', () => {
    setup();
    writeFileSync(
      join(tmpDir, '_headers'),
      '/assets/*/img/*\n  Cache-Control: public, max-age=3600\n',
    );
    expect(parseHeadersFile(tmpDir)).toEqual([
      {
        pattern: '/assets/*/img/*',
        headers: [['Cache-Control', 'public, max-age=3600']],
      },
    ]);
  });
});

describe('parseRedirectsFile', () => {
  it('parses standard _redirects file', () => {
    setup('/old /new 301\n/blog/* /posts/:splat 302\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toEqual({
      rules: [
        { source: '/old', destination: '/new', status: 301, origin: '_redirects:1' },
        { source: '/blog/*', destination: '/posts/:splat', status: 302, origin: '_redirects:2' },
      ],
      redundantForceOn3xx: 0,
    });
  });

  it('returns undefined when file does not exist', () => {
    setup(); // no file
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('skips comments and blank lines', () => {
    setup('# comment\n\n/old /new 301\n# another comment\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:3' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(0);
  });

  it('defaults status to 302 when omitted', () => {
    setup('/old /new\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 302, origin: '_redirects:1' },
    ]);
  });

  it('includes 200 rewrites alongside 3xx redirects', () => {
    setup('/app/* /index.html 200\n/old /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:1',
      },
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('parses 200! as force-true rewrite (Netlify-compat)', () => {
    setup('/app/* /index.html 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: true,
        origin: '_redirects:1',
      },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(0);
  });

  it('distinguishes force (200!) from non-force (200) rules in the same file', () => {
    setup('/fallback /spa.html 200\n/api/* /backend/:splat 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/fallback',
        destination: '/spa.html',
        status: 200,
        force: false,
        origin: '_redirects:1',
      },
      {
        source: '/api/*',
        destination: '/backend/:splat',
        status: 200,
        force: true,
        origin: '_redirects:2',
      },
    ]);
  });

  it('silently accepts 301! as a regular 301 and tallies redundant-force count', () => {
    setup('/old /new 301!\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:1' },
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(1);
  });

  it('silently accepts all 3xx force variants (301!, 302!, 307!, 308!)', () => {
    setup('/a /x 301!\n/b /x 302!\n/c /x 307!\n/d /x 308!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/a', destination: '/x', status: 301, origin: '_redirects:1' },
      { source: '/b', destination: '/x', status: 302, origin: '_redirects:2' },
      { source: '/c', destination: '/x', status: 307, origin: '_redirects:3' },
      { source: '/d', destination: '/x', status: 308, origin: '_redirects:4' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(4);
  });

  it('tolerates extra whitespace between fields', () => {
    setup('  /app/*   /index.html    200!  \n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: true,
        origin: '_redirects:1',
      },
    ]);
  });

  it('returns undefined for file with only comments', () => {
    setup('# just a comment\n# another one\n');
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('skips non-200 non-3xx status codes', () => {
    setup('/old /new 404\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('skips 200 rewrites with external destinations', () => {
    setup('/api/* https://upstream.example/:splat 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
  });

  it('skips 200! rewrites whose destination contains a query string', () => {
    setup('/docs /en/docs?lang=en 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toBeUndefined();
  });

  it('warns via voidWarn when a 200 rewrite destination contains "?" (skip path)', () => {
    // voidWarn writes through console.log — observe both that the entry was
    // dropped AND that a yellow-tagged warning surfaced for the author.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('/docs /en/docs?lang=en 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('must not contain "?"'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips _redirects entries whose source has more than one "*" and warns', () => {
    // Dispatch compiles `*` → `(?<splat>...)`; two of them yield duplicate
    // group names and crash the regex at startup. Drop the entry with a
    // friendly warning so the rest of the file still deploys.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('/a/*/b/* /dest 301\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((msg) => msg.includes('at most one "*" wildcard') && msg.includes('line 1')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('skips 200 rewrites whose destination is protocol-relative ("//host/x") and warns', () => {
    // `//host` parses as a cross-origin URL, which would turn the rewrite into a proxy.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('/docs //evil.com/docs 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('must not start with "//"'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips 200! force-rewrites whose destination is protocol-relative', () => {
    setup('/docs //evil.com/docs 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toBeUndefined();
  });

  // Host-prefixed sources: `https://host/path` on a `_redirects` line scopes
  // the rule to a specific Host header. The parser splits the URL, strips
  // the scheme + host, and stores them as `host` on the rule; `source`
  // becomes the path-only pattern. Lowercase-normalized so the byte-exact
  // match against `url.hostname` at dispatch is deterministic.

  it('extracts host and path from a https:// prefixed source', () => {
    setup('https://www.foo.com/* https://foo.com/:splat 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/*',
        destination: 'https://foo.com/:splat',
        status: 301,
        host: 'www.foo.com',
        origin: '_redirects:1',
      },
    ]);
  });

  it('lowercases mixed-case host on a https:// prefixed source', () => {
    setup('https://WWW.FOO.COM/about /about 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules[0].host).toBe('www.foo.com');
    expect(parsed?.rules[0].source).toBe('/about');
  });

  it('treats https://host (no path) as https://host/', () => {
    setup('https://www.foo.com /about 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules[0].source).toBe('/');
    expect(parsed?.rules[0].host).toBe('www.foo.com');
  });

  it('keeps host undefined for path-only sources', () => {
    setup('/old /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules[0]).not.toHaveProperty('host');
  });

  it('skips http:// sources (TLS terminates upstream)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('http://www.foo.com/about /about 301\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    // Only the path-only rule survives.
    expect(parsed?.rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('http://'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips protocol-relative // sources', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('//www.foo.com/about /about 301\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toHaveLength(1);
    expect(parsed?.rules[0].source).toBe('/ok');
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('protocol-relative'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips https:// sources with wildcard host', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('https://*.foo.com/* /:splat 301\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toHaveLength(1);
    expect(parsed?.rules[0].source).toBe('/ok');
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('literal hostname'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips https:// sources with port', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('https://www.foo.com:8080/* /:splat 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toBeUndefined();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('literal hostname'))).toBe(true);
    logSpy.mockRestore();
  });
});

describe('warnRedundantForceOn3xx', () => {
  // `parseRedirectsFile` tallies `!` suffixes on 3xx entries into
  // `redundantForceOn3xx` and strips them silently; the deploy pipeline
  // surfaces a single aggregated `log.warn` via `warnRedundantForceOn3xx`.
  it('skips emitting when the count is zero', async () => {
    const { warnRedundantForceOn3xx } = await import('../../src/cli/deploy-managed-events.ts');
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnRedundantForceOn3xx(0);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a single aggregated warning including the count when > 0', async () => {
    const { warnRedundantForceOn3xx } = await import('../../src/cli/deploy-managed-events.ts');
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnRedundantForceOn3xx(3);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('3');
    expect(warnSpy.mock.calls[0][0]).toContain('_redirects');
  });
});
