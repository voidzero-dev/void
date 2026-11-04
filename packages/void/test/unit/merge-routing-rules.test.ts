import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { mergeRoutingRules } from '../../src/cli/headers.ts';

const tmpDir = join(import.meta.dirname, '.tmp-merge-routing-rules');

function setup(files: { redirects?: string; headers?: string } = {}) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (files.redirects !== undefined) {
    writeFileSync(join(tmpDir, '_redirects'), files.redirects);
  }
  if (files.headers !== undefined) {
    writeFileSync(join(tmpDir, '_headers'), files.headers);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('mergeRoutingRules', () => {
  it('returns empty tables when neither file nor config has rules', () => {
    setup();
    const result = mergeRoutingRules({ dir: tmpDir, routing: undefined });
    expect(result.headerRules).toEqual([]);
    expect(result.redirectRules).toEqual([]);
    expect(result.fallbackRules).toBeUndefined();
    expect(result.redundantForceOn3xx).toBe(0);
  });

  it('tolerates a missing directory', () => {
    const result = mergeRoutingRules({
      dir: join(tmpDir, 'does-not-exist'),
      routing: { rewrites: { '/a': '/b' } },
    });
    expect(result.redirectRules).toHaveLength(1);
    expect(result.redirectRules[0]).toMatchObject({ source: '/a', destination: '/b', status: 200 });
  });

  it('skips file reads when dir is null but still merges config rules', () => {
    // `dir: null` corresponds to Vite `publicDir: false` — file-based
    // `_redirects`/`_headers` must not be read even if they exist at the
    // default `<root>/public`, but config-based rules still apply.
    setup({
      redirects: '/from-file /to-file 301',
      headers: '/file-scope\n  X-File: 1',
    });
    const result = mergeRoutingRules({
      dir: null,
      routing: { rewrites: { '/a': '/b' }, headers: { '/cfg-scope': ['X-Cfg: 1'] } },
    });
    expect(result.redirectRules).toHaveLength(1);
    expect(result.redirectRules[0]).toMatchObject({ source: '/a', destination: '/b', status: 200 });
    expect(result.headerRules).toHaveLength(1);
    expect(result.headerRules[0]).toMatchObject({ pattern: '/cfg-scope' });
  });

  it('buckets _redirects entries by phase: 3xx + 200! → redirects, plain 200 → fallbacks', () => {
    setup({
      redirects: [
        '/old           /new          301',
        '/docs/*        /handbook/:splat  200!',
        '/*             /index.html   200',
      ].join('\n'),
    });
    const result = mergeRoutingRules({ dir: tmpDir, routing: undefined });

    // Pre-asset phase has the 301 and the force-rewrite, but not the plain 200.
    const preAssetSources = result.redirectRules.map((r) => r.source);
    expect(preAssetSources).toEqual(['/old', '/docs/*']);
    expect(result.redirectRules[0].status).toBe(301);
    expect(result.redirectRules[1].status).toBe(200);
    expect(result.redirectRules[1].force).toBe(true);

    // Post-asset phase has only the plain 200.
    expect(result.fallbackRules).toBeDefined();
    expect(result.fallbackRules).toHaveLength(1);
    expect(result.fallbackRules![0]).toMatchObject({
      source: '/*',
      destination: '/index.html',
      status: 200,
      force: false,
    });
  });

  it('orders void.json rules before file rules so first-match-wins lets config override', () => {
    setup({
      redirects: '/docs/*   /en/docs/:splat   200!',
    });
    const result = mergeRoutingRules({
      dir: tmpDir,
      routing: { rewrites: { '/docs/*': '/handbook/:splat' } },
    });

    expect(result.redirectRules).toHaveLength(2);
    expect(result.redirectRules[0].origin).toBe('void.config.ts#routing.rewrites');
    expect(result.redirectRules[0].destination).toBe('/handbook/:splat');
    expect(result.redirectRules[1].origin).toMatch(/^_redirects:/);
    expect(result.redirectRules[1].destination).toBe('/en/docs/:splat');
  });

  it('merges fallbacks from both sources in config-first order', () => {
    setup({
      redirects: '/app/*   /app.html   200',
    });
    const result = mergeRoutingRules({
      dir: tmpDir,
      routing: { fallbacks: { '/docs/*': '/docs.html' } },
    });
    expect(result.fallbackRules).toBeDefined();
    expect(result.fallbackRules).toHaveLength(2);
    expect(result.fallbackRules![0].source).toBe('/docs/*');
    expect(result.fallbackRules![1].source).toBe('/app/*');
  });

  it('merges _headers file entries before routing.headers config entries', () => {
    setup({
      headers: ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable'].join('\n'),
    });
    const result = mergeRoutingRules({
      dir: tmpDir,
      routing: { headers: { '/secure/*': ['X-Frame-Options: DENY'] } },
    });
    expect(result.headerRules).toHaveLength(2);
    expect(result.headerRules[0].pattern).toBe('/assets/*');
    expect(result.headerRules[1].pattern).toBe('/secure/*');
    expect(result.headerRules[1].headers).toEqual([['X-Frame-Options', 'DENY']]);
  });

  it('surfaces redundantForceOn3xx count from the parsed _redirects file', () => {
    setup({
      redirects: ['/old   /new   301!', '/gone  /     302!'].join('\n'),
    });
    const result = mergeRoutingRules({ dir: tmpDir, routing: undefined });
    expect(result.redundantForceOn3xx).toBe(2);
    // `!` on a 3xx is silently stripped — the rules stay in the pre-asset bucket.
    expect(result.redirectRules).toHaveLength(2);
  });

  // Documented at docs/guide/edge/rewrites.md §"Precedence: _redirects vs
  // void.json" — within the pre-asset phase the order is always
  //   routing.redirects → routing.rewrites → _redirects
  // so when the same source appears in both `routing.redirects` and
  // `routing.rewrites`, the redirect wins under first-match-wins. Pin the
  // ordering here so a refactor of `mergeRoutingRules` can't silently flip
  // which entry takes precedence.
  it('orders routing.redirects before routing.rewrites so same-source redirects override rewrites', () => {
    setup();
    const result = mergeRoutingRules({
      dir: tmpDir,
      routing: {
        redirects: { '/x': '/from-redirect' },
        rewrites: { '/x': '/from-rewrite' },
      },
    });

    expect(result.redirectRules).toHaveLength(2);
    expect(result.redirectRules[0]).toMatchObject({
      source: '/x',
      destination: '/from-redirect',
      origin: 'void.config.ts#routing.redirects',
    });
    expect(result.redirectRules[1]).toMatchObject({
      source: '/x',
      destination: '/from-rewrite',
      origin: 'void.config.ts#routing.rewrites',
    });
  });

  it('leaves fallbackRules undefined when no fallbacks exist in either source', () => {
    setup({
      redirects: '/old   /new   301',
    });
    const result = mergeRoutingRules({
      dir: tmpDir,
      routing: { redirects: { '/a': '/b' } },
    });
    expect(result.fallbackRules).toBeUndefined();
  });
});
