import { describe, expect, it } from 'vite-plus/test';
import {
  GENERATED_ASSET_HEADERS_MARKER,
  isGeneratedAssetHeaders,
  normalizeAssetsDir,
  patternCanReachUnder,
  resolveAssetWorkerBypass,
  type AssetWorkerBypassFacts,
} from '../../src/asset-worker-bypass.ts';

function facts(overrides: Partial<AssetWorkerBypassFacts> = {}): AssetWorkerBypassFacts {
  return {
    runWorkerFirst: ['/**'],
    notFoundHandling: 'none',
    base: '/',
    hasMiddleware: false,
    authEnabled: false,
    headerRuleCount: 0,
    redirectRuleCount: 0,
    fallbackRuleCount: 0,
    publicEdgeFiles: false,
    patterns: ['/', '/api/users/:id', '/blog/:slug'],
    assetsDir: 'assets',
    immutableFiles: ['assets/main-abcdefgh.js', 'assets/chunk-12345678.js'],
    ...overrides,
  };
}

const files = (count: number) =>
  Array.from({ length: count }, (_, i) => `assets/chunk-${String(i).padStart(8, '0')}.js`);

describe('patternCanReachUnder', () => {
  it.each(['/assets/:id', '/:a/:b', '/:slug{.+}', '*', '/*', '/Assets/x', '/assets/*'])(
    '%s can reach /assets/*',
    (pattern) => {
      expect(patternCanReachUnder(pattern, 'assets')).toBe(true);
    },
  );

  it.each(['/:slug', '/assets', '/api/*', '/blog/:id', '/'])(
    '%s cannot reach /assets/*',
    (pattern) => {
      expect(patternCanReachUnder(pattern, 'assets')).toBe(false);
    },
  );

  it('walks nested asset directories segment by segment', () => {
    expect(patternCanReachUnder('/static/:x/:y', 'static/build')).toBe(true);
    expect(patternCanReachUnder('/static/:x', 'static/build')).toBe(false);
  });
});

describe('normalizeAssetsDir', () => {
  it('trims slashes and rejects an empty directory', () => {
    expect(normalizeAssetsDir('/assets/')).toBe('assets');
    expect(normalizeAssetsDir('static/build')).toBe('static/build');
    expect(normalizeAssetsDir('')).toBeNull();
    expect(normalizeAssetsDir('/')).toBeNull();
    expect(normalizeAssetsDir('.')).toBeNull();
  });
});

describe('resolveAssetWorkerBypass', () => {
  it('lets eligible apps, including auth apps, skip the Worker for the assets folder', () => {
    const expected = {
      runWorkerFirst: ['/**', '!/assets/*'],
      headers: `${GENERATED_ASSET_HEADERS_MARKER}
/assets/chunk-12345678.js
  Cache-Control: public, max-age=31536000, immutable
/assets/main-abcdefgh.js
  Cache-Control: public, max-age=31536000, immutable
`,
    };
    expect(resolveAssetWorkerBypass(facts())).toEqual(expected);
    expect(resolveAssetWorkerBypass(facts({ authEnabled: true }))).toEqual(expected);
  });

  it('lists only immutable files under the assets folder', () => {
    const headers = resolveAssetWorkerBypass(
      facts({ immutableFiles: ['root-abcdefgh.js', 'assets/a-12345678.js'] }),
    )?.headers;
    expect(headers).toContain('/assets/a-12345678.js\n');
    expect(headers).not.toContain('root-abcdefgh');
  });

  it.each<[string, Partial<AssetWorkerBypassFacts>]>([
    ['run_worker_first true', { runWorkerFirst: true }],
    ['an API-only run_worker_first', { runWorkerFirst: ['/api', '/api/*'] }],
    ['an extra run_worker_first rule', { runWorkerFirst: ['/**', '/x'] }],
    ['a SPA not_found_handling', { notFoundHandling: 'single-page-application' }],
    ['a non-root base', { base: '/app/' }],
    ['middleware', { hasMiddleware: true }],
    ['a header rule', { headerRuleCount: 1 }],
    ['a redirect rule', { redirectRuleCount: 1 }],
    ['a fallback rule', { fallbackRuleCount: 1 }],
    ['public edge files', { publicEdgeFiles: true }],
    ['an empty assetsDir', { assetsDir: '' }],
    ['an assetsDir with a placeholder', { assetsDir: 'a:b' }],
    ['a revalidate * key', { patterns: ['*'] }],
    ['a clashing page pattern', { patterns: ['/:section/:slug'] }],
    ['Void internal paths', { assetsDir: '__void', immutableFiles: ['__void/a-12345678.js'] }],
    [
      'auth paths',
      { authEnabled: true, assetsDir: 'api/auth', immutableFiles: ['api/auth/a-12345678.js'] },
    ],
    ['no immutable files', { immutableFiles: [] }],
    ['101 immutable files', { immutableFiles: files(101) }],
    ['a file name with a placeholder', { immutableFiles: ['assets/a:b-12345678.js'] }],
    [
      'a rule over 100 characters',
      { assetsDir: 'a'.repeat(97), immutableFiles: [`${'a'.repeat(97)}/x-12345678.js`] },
    ],
  ])('keeps the Worker in front for %s', (_name, overrides) => {
    expect(resolveAssetWorkerBypass(facts(overrides))).toBeNull();
  });

  it('accepts exactly 100 immutable files', () => {
    const headers = resolveAssetWorkerBypass(facts({ immutableFiles: files(100) }))?.headers;
    expect(headers?.split('\n').filter((line) => line.startsWith('/'))).toHaveLength(100);
  });
});

describe('isGeneratedAssetHeaders', () => {
  it('recognises only the marker line', () => {
    expect(isGeneratedAssetHeaders(`${GENERATED_ASSET_HEADERS_MARKER}\n/a\n`)).toBe(true);
    expect(isGeneratedAssetHeaders(`${GENERATED_ASSET_HEADERS_MARKER}\r\n/a\r\n`)).toBe(true);
    expect(isGeneratedAssetHeaders(GENERATED_ASSET_HEADERS_MARKER)).toBe(true);
    expect(isGeneratedAssetHeaders('/assets/*\n  Cache-Control: no-store\n')).toBe(false);
    expect(isGeneratedAssetHeaders(`# note\n${GENERATED_ASSET_HEADERS_MARKER}\n`)).toBe(false);
  });
});
