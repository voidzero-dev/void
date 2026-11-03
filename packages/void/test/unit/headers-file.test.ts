import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { GENERATED_ASSET_HEADERS_MARKER } from '../../src/asset-worker-bypass.ts';
import { parseHeadersFile, readGeneratedAssetHeadersFile } from '../../src/cli/headers.ts';

const tmpDir = join(import.meta.dirname, '.tmp-headers-file-test');

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, '_headers'), content);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseHeadersFile', () => {
  it('returns undefined for missing file', () => {
    setup(); // no _headers written
    expect(parseHeadersFile(tmpDir)).toBeUndefined();
  });

  it('returns undefined for empty file', () => {
    setup('');
    expect(parseHeadersFile(tmpDir)).toBeUndefined();
  });

  it('returns undefined for file with only comments and blanks', () => {
    setup('# This is a comment\n\n# Another comment\n');
    expect(parseHeadersFile(tmpDir)).toBeUndefined();
  });

  it('parses SvelteKit format (comments, ! directives, mixed indentation)', () => {
    setup(
      [
        '# SvelteKit generated headers',
        '/_app/*',
        '  Cache-Control: no-cache',
        '  X-Robots-Tag: noindex',
        '',
        '/_app/immutable/*',
        '\tCache-Control: public, immutable, max-age=31536000',
      ].join('\n'),
    );
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/_app/*',
        headers: [
          ['Cache-Control', 'no-cache'],
          ['X-Robots-Tag', 'noindex'],
        ],
      },
      {
        pattern: '/_app/immutable/*',
        headers: [['Cache-Control', 'public, immutable, max-age=31536000']],
      },
    ]);
  });

  it('parses Nuxt format and sorts by pattern length (most-specific last)', () => {
    // Nuxt _headers lists most-specific first — parser should reorder
    setup(
      [
        '/_nuxt/builds/meta/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '/_nuxt/builds/*',
        '  Cache-Control: public, max-age=1, must-revalidate',
        '/_nuxt/*',
        '  Cache-Control: public, max-age=31536000, immutable',
      ].join('\n'),
    );
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/_nuxt/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
      {
        pattern: '/_nuxt/builds/*',
        headers: [['Cache-Control', 'public, max-age=1, must-revalidate']],
      },
      {
        pattern: '/_nuxt/builds/meta/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
    ]);
  });

  it('skips ! unset directives', () => {
    setup(['/api/*', '  ! Cache-Control', '  X-Custom: value'].join('\n'));
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/api/*',
        headers: [['X-Custom', 'value']],
      },
    ]);
  });

  it('handles colons in header values', () => {
    setup(['/*', '  Link: <https://example.com>; rel="preconnect"'].join('\n'));
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/*',
        headers: [['Link', '<https://example.com>; rel="preconnect"']],
      },
    ]);
  });

  it('skips blocks with no valid headers', () => {
    setup(['/empty/*', '  ! Remove-This', '/valid/*', '  X-Custom: yes'].join('\n'));
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/valid/*',
        headers: [['X-Custom', 'yes']],
      },
    ]);
  });

  it('sorts by pattern length ascending (shortest first)', () => {
    setup(['/a/b/c/*', '  X: 1', '/*', '  X: 2', '/a/*', '  X: 3'].join('\n'));
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      { pattern: '/*', headers: [['X', '2']] },
      { pattern: '/a/*', headers: [['X', '3']] },
      { pattern: '/a/b/c/*', headers: [['X', '1']] },
    ]);
  });

  it('skips lines without colons in header position', () => {
    setup(['/*', '  no-colon-here', '  Valid-Header: yes'].join('\n'));
    const result = parseHeadersFile(tmpDir);
    expect(result).toEqual([
      {
        pattern: '/*',
        headers: [['Valid-Header', 'yes']],
      },
    ]);
  });
});

describe('readGeneratedAssetHeadersFile', () => {
  it('returns the text of the _headers file Void generated', () => {
    const content = `${GENERATED_ASSET_HEADERS_MARKER}\n/assets/app.js\n  Cache-Control: immutable\n`;
    setup(content);
    expect(readGeneratedAssetHeadersFile(tmpDir)).toBe(content);
  });

  it('ignores a user-authored or missing file', () => {
    setup('/*\n  X-Test: yes\n');
    expect(readGeneratedAssetHeadersFile(tmpDir)).toBeUndefined();
    setup();
    expect(readGeneratedAssetHeadersFile(tmpDir)).toBeUndefined();
  });
});
