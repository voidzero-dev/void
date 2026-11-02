import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  buildFrameworkManifest,
  buildStaticManifest,
  readWranglerHtmlHandling,
  buildVoidManifest,
  computeAssetHash,
  collectAndHashAssets,
  collectWorkerFiles,
  resolveSpaFallbackChain,
} from '../../src/cli/package.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';

const TMP = join(import.meta.dirname, '.tmp-package-test');

function makeBindings(overrides: Partial<InferredBindings> = {}): InferredBindings {
  return {
    needsD1: false,
    needsKV: false,
    needsR2: false,
    needsAuth: false,
    needsQueues: false,
    needsAI: false,
    needsSandbox: false,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(join(import.meta.dirname, 'outside-secret.txt'), { force: true });
});

describe('worker packaging', () => {
  it.each([true, false, undefined])(
    'preserves alwaysUseHttps %s in every app manifest',
    (value) => {
      const manifests = [
        buildVoidManifest({ bindings: makeBindings(), alwaysUseHttps: value }),
        buildStaticManifest({ appType: 'static', alwaysUseHttps: value }),
        buildFrameworkManifest({
          frameworkName: 'nuxt',
          workerMain: 'index.mjs',
          bindings: makeBindings(),
          alwaysUseHttps: value,
        }),
      ];
      for (const manifest of manifests) {
        const published = JSON.parse(JSON.stringify(manifest));
        expect(published.alwaysUseHttps).toBe(value);
        expect(Object.hasOwn(published, 'alwaysUseHttps')).toBe(value !== undefined);
      }
    },
  );
  it('marks Sandbox bundles as controller-capable and omits metadata for apps without Sandbox', () => {
    const manifest = buildVoidManifest({
      bindings: makeBindings({ needsSandbox: true }),
      options: {
        sandbox: {
          binding: 'SANDBOX',
          className: 'Sandbox',
          containerName: 'void-sandbox',
          image:
            'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          platformImage:
            'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    });
    expect(manifest.sandbox).toMatchObject({ controllerProtocol: 2, bindingName: 'SANDBOX' });
    expect(buildVoidManifest({ bindings: makeBindings() }).sandbox).toBeUndefined();
  });

  it('keeps the manifest workerMain aligned with uploaded worker modules', () => {
    writeFileSync(join(TMP, 'index.mjs'), 'export default { fetch() {} };');
    writeFileSync(join(TMP, 'index.js.map'), '{}');
    writeFileSync(join(TMP, 'wrangler.json'), JSON.stringify({ main: 'index.mjs' }));

    const manifest = buildVoidManifest({
      bindings: makeBindings(),
      ssr: true,
      options: {
        workerMain: 'index.mjs',
      },
    });
    const workerFiles = collectWorkerFiles(TMP);

    expect(manifest.workerMain).toBe('index.mjs');
    expect(workerFiles.has(manifest.workerMain!)).toBe(true);
    expect(workerFiles.has('wrangler.json')).toBe(false);
  });
});

describe('buildVoidManifest', () => {
  it('emits the managed Durable Object protocol only for apps that use custom classes', () => {
    const plain = buildVoidManifest({ bindings: makeBindings() });
    expect(plain.version).toBe(3);
    expect(plain.durableObjects).toBeUndefined();
    const durable = buildVoidManifest({
      bindings: makeBindings(),
      durableObjects: [{ bindingName: 'WORKSPACE', className: 'WorkspaceDurableObject' }],
    });
    expect(durable.version).toBe(4);
    expect(durable.durableObjects).toEqual({
      bindings: [
        { bindingName: 'WORKSPACE', className: 'WorkspaceDurableObject', storage: 'sqlite' },
      ],
    });
  });
  it('advertises authenticated email protocol only for a managed inbound handler', () => {
    expect(
      buildVoidManifest({ bindings: makeBindings(), hasEmailHandlers: true }).emailProtocolVersion,
    ).toBe(1);
    expect(
      buildVoidManifest({ bindings: makeBindings({ needsEmail: true }) }).emailProtocolVersion,
    ).toBeUndefined();
    const noEmail = buildVoidManifest({ bindings: makeBindings() });
    expect(noEmail.emailProtocolVersion).toBeUndefined();
    expect(noEmail.bindings).toEqual({});
  });

  it('sets bindings.ai === true when the app needs Workers AI', () => {
    const manifest = buildVoidManifest({ bindings: makeBindings({ needsAI: true }) });
    expect(manifest.bindings.ai).toBe(true);
  });

  it('carries revalidate into manifest.revalidate and omits it when unset or 0', () => {
    const revalidate = { '/blog/:slug': 120, '*': 60 };
    expect(
      Object.entries(buildVoidManifest({ bindings: makeBindings(), revalidate }).revalidate ?? {}),
    ).toEqual(Object.entries(revalidate));
    expect(buildVoidManifest({ bindings: makeBindings() }).revalidate).toBeUndefined();
    expect(
      buildVoidManifest({ bindings: makeBindings(), revalidate: 0 }).revalidate,
    ).toBeUndefined();
  });

  it('carries a pages array verbatim into manifest.pages', () => {
    const pages = [
      { pattern: '/docs/setup/install' },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ];
    const manifest = buildVoidManifest({ bindings: makeBindings(), pages });
    expect(manifest.pages).toEqual(pages);
  });

  it('omits manifest.pages when the pages array is empty or missing', () => {
    expect(buildVoidManifest({ bindings: makeBindings(), pages: [] }).pages).toBeUndefined();
    expect(buildVoidManifest({ bindings: makeBindings() }).pages).toBeUndefined();
  });
});

describe('manifest limits (worker.limits.cpu_ms)', () => {
  it('emits manifest.limits when options.cpuMs is set (void manifest)', () => {
    const manifest = buildVoidManifest({ bindings: makeBindings(), options: { cpuMs: 50 } });
    expect(manifest.limits).toEqual({ cpuMs: 50 });
  });

  it('omits the limits key entirely when options.cpuMs is unset (void manifest)', () => {
    const manifest = buildVoidManifest({ bindings: makeBindings(), options: {} });
    expect('limits' in manifest).toBe(false);
  });

  it('emits manifest.limits when packageOptions.cpuMs is set (framework manifest)', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'astro',
      workerMain: 'index.mjs',
      bindings: makeBindings(),
      packageOptions: { cpuMs: 30000 },
    });
    expect(manifest.limits).toEqual({ cpuMs: 30000 });
  });

  it('omits the limits key entirely when packageOptions.cpuMs is unset (framework manifest)', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'astro',
      workerMain: 'index.mjs',
      bindings: makeBindings(),
      packageOptions: {},
    });
    expect('limits' in manifest).toBe(false);
  });
});

describe('resolveSpaFallbackChain', () => {
  it('returns SPA platform switch with no rules when user has no fallbacks (SPA)', () => {
    const result = resolveSpaFallbackChain('spa', undefined);
    expect(result.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(result.fallbackRules).toBeUndefined();
  });

  it('appends synthetic catch-all after user fallbacks (SPA)', () => {
    // Under first-match-wins, user rules must come BEFORE the synthetic
    // catch-all so a more-specific user rule fires first; the synthetic
    // `/*` only catches paths no user rule matched.
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('spa', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
    ]);
  });

  it('returns the user rules verbatim (no append, no duplication) when user already has /* -> /index.html', () => {
    const userRules = [
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const result = resolveSpaFallbackChain('spa', userRules);

    // Platform SPA switch disabled — we're handling the catch-all via rules.
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    // No synthetic rule prepended: the returned list is exactly what the user supplied.
    expect(result.fallbackRules).toEqual(userRules);
  });

  it('still appends synthetic catch-all when user catch-all is host-scoped (SPA)', () => {
    // A host-scoped `/*` -> `/index.html` only covers one hostname, so other
    // bound hosts still need the synthetic global SPA fallback.
    const userRules = [
      {
        host: 'www.example.com',
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const result = resolveSpaFallbackChain('spa', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      ...userRules,
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
    ]);
  });

  it('leaves user fallbacks untouched for static app type', () => {
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('static', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: '404-page' });
    expect(result.fallbackRules).toEqual(userRules);
  });

  it('returns none and undefined rules for undefined app type with no user rules', () => {
    const result = resolveSpaFallbackChain(undefined, undefined);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toBeUndefined();
  });

  // `routing.notFound` (void.json) is appType-independent — the worker path
  // already honors it via `resolveAssetRoutingPolicy`. `detectPreset`
  // classifies any Vite project with no backend files as `spa`, so a plain
  // Vite MPA lands on `appType: 'spa'` and this override is its only way to
  // get a real 404 instead of the SPA shell with HTTP 200.
  it('honors an explicit notFound over the appType-inferred handling (SPA)', () => {
    expect(resolveSpaFallbackChain('spa', undefined, '404-page').assetConfig).toEqual({
      not_found_handling: '404-page',
    });
    expect(resolveSpaFallbackChain('spa', undefined, 'none').assetConfig).toEqual({
      not_found_handling: 'none',
    });
  });

  it('does not synthesise the SPA catch-all when notFound overrides away from SPA', () => {
    // Applying the override AFTER the SPA branch would leave the synthetic
    // `/* -> /index.html` rule in place, so the SPA shell would still be
    // served (via a rule instead of the platform switch) and the override
    // would be a no-op.
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('spa', userRules, '404-page');
    expect(result.assetConfig).toEqual({ not_found_handling: '404-page' });
    expect(result.fallbackRules).toEqual(userRules);
  });

  it('takes the SPA branch when notFound explicitly asks for single-page-application', () => {
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('static', userRules, 'single-page-application');
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      ...userRules,
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
    ]);
  });
});

describe('buildStaticManifest', () => {
  it('infers not_found_handling from appType when notFound is unset', () => {
    expect(buildStaticManifest({ appType: 'static' }).assetConfig).toEqual({
      not_found_handling: '404-page',
    });
    expect(buildStaticManifest({ appType: 'spa' }).assetConfig).toEqual({
      not_found_handling: 'single-page-application',
    });
  });

  it('ships only the user fallbacks when notFound overrides the SPA default', () => {
    const manifest = buildStaticManifest({
      appType: 'spa',
      notFound: '404-page',
      fallbackRules: [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }],
    });
    expect(manifest.type).toBe('spa');
    expect(manifest.assetConfig).toEqual({ not_found_handling: '404-page' });
    expect(manifest.fallbackRules).toEqual([
      { source: '/docs/*', destination: '/docs.html', status: 200 },
    ]);
  });

  it('carries authored html_handling into assetConfig', () => {
    expect(
      buildStaticManifest({ appType: 'static', html_handling: 'drop-trailing-slash' }).assetConfig,
    ).toEqual({
      not_found_handling: '404-page',
      html_handling: 'drop-trailing-slash',
    });
  });
});

describe('readWranglerHtmlHandling', () => {
  it('reads a supported assets.html_handling value', () => {
    expect(
      readWranglerHtmlHandling({
        assets: { html_handling: 'drop-trailing-slash' },
      }),
    ).toBe('drop-trailing-slash');
  });

  it('ignores missing or invalid values', () => {
    expect(readWranglerHtmlHandling({})).toBeUndefined();
    expect(readWranglerHtmlHandling({ assets: { html_handling: 'bogus' } })).toBeUndefined();
  });
});

describe('collectAndHashAssets', () => {
  it('collects files with hashes and sizes', async () => {
    mkdirSync(join(TMP, 'assets'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html>hello</html>');
    writeFileSync(join(TMP, 'assets', 'app.js'), "console.log('hi')");

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest).sort()).toEqual(['/assets/app.js', '/index.html']);
    expect(assetManifest['/index.html'].hash).toHaveLength(32);
    expect(assetManifest['/index.html'].size).toBe(Buffer.from('<html>hello</html>').length);
    expect(assetFiles.size).toBe(2);
  });

  it('emits { blake3, md5, size, hash } per entry', async () => {
    writeFileSync(join(TMP, 'a.js'), 'hello\n');

    const { assetManifest } = await collectAndHashAssets(TMP);

    expect(assetManifest['/a.js']).toEqual({
      blake3: 'dc6c72af24e164d6188743458a7da473',
      md5: 'b1946ac92492d2347c6235b4d2611184',
      size: Buffer.from('hello\n').length,
      hash: 'dc6c72af24e164d6188743458a7da473',
    });
  });

  it("matches Wrangler's hashFile BLAKE3 recipe", () => {
    expect(computeAssetHash(Buffer.from('const x = 1;\n'), 'foo.js')).toBe(
      '3725f96aa779d1959d5942b1b4e04567',
    );
  });

  it('returns empty manifest for missing directory', async () => {
    const { assetManifest, assetFiles } = await collectAndHashAssets(join(TMP, 'nonexistent'));

    expect(Object.keys(assetManifest)).toHaveLength(0);
    expect(assetFiles.size).toBe(0);
  });

  it('excludes _headers, _redirects, and .assetsignore from manifest', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_headers'), '/* X-Frame-Options: DENY');
    writeFileSync(join(TMP, '_redirects'), '/old /new 301');
    writeFileSync(join(TMP, '.assetsignore'), '');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('excludes macOS .DS_Store metadata files from manifest', async () => {
    mkdirSync(join(TMP, 'assets'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '.DS_Store'), 'metadata');
    writeFileSync(join(TMP, 'assets', '.DS_Store'), 'metadata');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('excludes dotenv files from manifest', async () => {
    mkdirSync(join(TMP, 'nested'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '.env.local'), 'SECRET_TOKEN=should-not-be-public');
    writeFileSync(join(TMP, '.env.production.local'), 'PROD_SECRET=should-not-be-public');
    writeFileSync(join(TMP, 'nested', '.env'), 'NESTED_SECRET=should-not-be-public');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('honors custom .assetsignore patterns', async () => {
    mkdirSync(join(TMP, 'secret'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, 'draft.txt'), 'draft');
    writeFileSync(join(TMP, 'secret', 'key.pem'), 'secret');
    writeFileSync(join(TMP, '.assetsignore'), '*.txt\nsecret/');

    const { assetManifest } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
  });
});

describe('_worker.js safety guard (collectAndHashAssets)', () => {
  it('throws when a static asset is a symlink', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload symlink as an asset',
    );
  });

  it('allows symlinks excluded by .assetsignore', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));
    writeFileSync(join(TMP, '.assetsignore'), 'linked-secret.txt');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('allows symlinks excluded by deploy ignore patterns', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP, undefined, {
      ignorePatterns: ['/linked-secret.txt'],
    });

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('throws when _worker.js file exists without .assetsignore', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload _worker.js file as an asset',
    );
  });

  it('throws when _worker.js directory exists without .assetsignore', async () => {
    mkdirSync(join(TMP, '_worker.js'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js', 'index.js'), 'export default {}');

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload _worker.js directory as an asset',
    );
  });

  it('allows _worker.js when .assetsignore exists (even if empty)', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '');

    const { assetManifest } = await collectAndHashAssets(TMP);
    // _worker.js is included because .assetsignore doesn't exclude it
    expect(Object.keys(assetManifest).sort()).toEqual(['/_worker.js', '/index.html']);
  });

  it('excludes _worker.js when .assetsignore lists it', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '_worker.js');

    const { assetManifest } = await collectAndHashAssets(TMP);
    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
  });

  it('lets framework deploys ignore co-located worker control files during preflight', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '_routes.json'), '{}');

    const { assetManifest } = await collectAndHashAssets(TMP, undefined, {
      ignorePatterns: ['/_worker.js', '/_routes.json'],
    });

    expect(Object.keys(assetManifest).sort()).toEqual(['/index.html']);
  });
});
