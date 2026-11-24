import { describe, expect, it } from 'vite-plus/test';
import { assembleVoidManifest } from '../../src/cli/deploy-managed-static.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';
import { makePage, makeScan } from '../helpers/page-scan.ts';

// Minimal all-false bindings — `manifest.pages` emission is independent of
// bindings, so this is the smallest valid `buildVoidManifest` input.
const MINIMAL_BINDINGS: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

it('disables managed ISR policies and edge prerendering with routing.isr false', () => {
  const manifest = assembleVoidManifest(
    makeScan([makePage('/', 31_536_000)]),
    false,
    {
      bindings: MINIMAL_BINDINGS,
      revalidate: 60,
      prerender: ['/'],
    },
    { '*': 120 },
    false,
  );
  expect(manifest.revalidate).toBeUndefined();
  expect(manifest.pathRevalidate).toBeUndefined();
  expect(manifest.prerender).toBeUndefined();
  expect(manifest.pages).toEqual([{ pattern: '/' }]);
});

describe('assembleVoidManifest', () => {
  it('forwards the page scan into manifest.pages (ordered, raw patterns, ISR TTL preserved)', () => {
    const pageScan = makeScan([
      makePage('/docs/setup/install'), // static, no revalidate
      makePage('/blog/:slug', 120), // dynamic segment, ISR
      makePage('/docs/:path{.+}', 3600), // catch-all, ISR, RAW pattern
    ]);
    const manifest = assembleVoidManifest(pageScan, false, { bindings: MINIMAL_BINDINGS });
    expect(manifest.pages).toEqual([
      { pattern: '/docs/setup/install' },
      { pattern: '/blog/:slug', revalidate: 120 },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ]);
  });

  it('omits manifest.pages and pathRevalidate in framework mode', () => {
    // `pages` is a Void pages-mode concept: a Class-A framework routed through
    // runFullDeploy must NOT emit it, even when it happens to have a pages/ dir.
    const scan = makeScan([makePage('/isr', 60)]);
    const manifest = assembleVoidManifest(
      scan,
      true,
      { bindings: MINIMAL_BINDINGS },
      { '/blog/*': 3600 },
    );
    expect(manifest.pages).toBeUndefined();
    expect(manifest.pathRevalidate).toBeUndefined();
  });

  it('ships the RAW object config as manifest.pathRevalidate; those pages stay inherit-eligible', () => {
    // Object `routing.revalidate` is not baked — pages stay inherit-eligible
    // (absent revalidate) and the RAW config ships so dispatch resolves it
    // per-path against the real request path.
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    const manifest = assembleVoidManifest(
      scan,
      false,
      { bindings: MINIMAL_BINDINGS },
      {
        '/blog/private': 0,
        '/blog/*': 3600,
      },
    );
    expect(manifest.pages).toEqual([{ pattern: '/blog/:slug' }, { pattern: '/about' }]);
    expect(manifest.pathRevalidate).toEqual({ '/blog/private': 0, '/blog/*': 3600 });
  });

  it('omits manifest.pathRevalidate for a global-number config (baked into every page)', () => {
    // A number config is fully baked into `pages`, so no inherit-eligible page
    // exists and pathRevalidate would never be consulted — it is not shipped.
    const scan = makeScan([makePage('/a'), makePage('/b')]);
    const manifest = assembleVoidManifest(scan, false, { bindings: MINIMAL_BINDINGS }, 3600);
    expect(manifest.pages).toEqual([
      { pattern: '/a', revalidate: 3600 },
      { pattern: '/b', revalidate: 3600 },
    ]);
    expect(manifest.pathRevalidate).toBeUndefined();
  });
});
