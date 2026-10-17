import type { Rolldown } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import {
  hasHashedAssetFileNames,
  stampClientAssetCachePolicy,
} from '../../src/client-asset-manifest.ts';
import type { ClientManifest } from '../../src/runtime/routing-assets.ts';

const MANIFEST = '.vite/manifest.json';

function bundle(manifest: ClientManifest): Rolldown.OutputBundle {
  const items: Record<string, unknown> = {
    [MANIFEST]: { type: 'asset', fileName: MANIFEST, source: JSON.stringify(manifest) },
    'assets/main-abc123.js': {
      type: 'chunk',
      fileName: 'assets/main-abc123.js',
      preliminaryFileName: 'assets/main-!~{001}~.js',
    },
    'assets/hero-abc123.png': { type: 'asset', fileName: 'assets/hero-abc123.png', source: '' },
    'assets/plain-abc123.png': { type: 'asset', fileName: 'assets/plain-abc123.png', source: '' },
    'assets/private-abc123.png': {
      type: 'asset',
      fileName: 'assets/private-abc123.png',
      source: '',
    },
  };
  return items as unknown as Rolldown.OutputBundle;
}

const manifest: ClientManifest = {
  'src/main.ts': { file: 'assets/main-abc123.js', imports: [] },
  'src/hero.png': { file: 'assets/hero-abc123.png' },
  'src/plain.png': { file: 'assets/plain-abc123.png' },
  'src/private.png': { file: 'assets/private-abc123.png' },
  'src/inlined.png': { file: 'assets/inlined-abc123.png' },
};

const stamped = (output: Rolldown.OutputBundle): Record<string, Array<string> | undefined> =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(String((output[MANIFEST] as Rolldown.OutputAsset).source)) as ClientManifest,
    ).map(([key, entry]) => [key, entry.immutableFiles]),
  );

describe('stampClientAssetCachePolicy with ?image sources', () => {
  it('keeps the existing output byte-identical without image proof', () => {
    const plain = bundle(manifest);
    const withEmptyProof = bundle(manifest);
    stampClientAssetCachePolicy(plain, MANIFEST);
    stampClientAssetCachePolicy(withEmptyProof, MANIFEST, [], {
      imageSources: ['src/hero.png'],
      hashedAssetFileNames: false,
    });
    expect((withEmptyProof[MANIFEST] as Rolldown.OutputAsset).source).toBe(
      (plain[MANIFEST] as Rolldown.OutputAsset).source,
    );
    expect(stamped(plain)).toEqual({
      'src/main.ts': ['assets/main-abc123.js'],
      'src/hero.png': undefined,
      'src/plain.png': undefined,
      'src/private.png': undefined,
      'src/inlined.png': undefined,
    });
  });

  it('stamps emitted ?image assets under a proven [hash] template only', () => {
    const output = bundle(manifest);
    stampClientAssetCachePolicy(
      output,
      MANIFEST,
      [{ pattern: '/assets/private-*', headers: [['Cache-Control', 'private, no-store']] }],
      {
        imageSources: new Set([
          'src/hero.png',
          'src/private.png',
          'src/inlined.png',
          'src/missing.png',
        ]),
        hashedAssetFileNames: true,
      },
    );
    expect(stamped(output)).toEqual({
      'src/main.ts': ['assets/main-abc123.js'],
      // Imported with `?image`, emitted, and not covered by an authored policy.
      'src/hero.png': ['assets/hero-abc123.png'],
      // Imported without `?image`: unproven, as before.
      'src/plain.png': undefined,
      // An authored Cache-Control rule keeps its policy.
      'src/private.png': undefined,
      // Inlined or otherwise not emitted under that name.
      'src/inlined.png': undefined,
    });
  });
});

describe('hasHashedAssetFileNames', () => {
  it.each<[string, unknown, boolean]>([
    ['no output options', undefined, true],
    ["Vite's default template", {}, true],
    ['a template with [hash]', { assetFileNames: 'static/[name]-[hash][extname]' }, true],
    ['a template without [hash]', { assetFileNames: 'static/[name][extname]' }, false],
    ['a function template', { assetFileNames: () => 'static/[name]-[hash][extname]' }, false],
    ['several outputs that all hash', [{ assetFileNames: '[hash].[ext]' }, {}], true],
    ['several outputs where one does not hash', [{}, { assetFileNames: '[name].[ext]' }], false],
  ])('treats %s as hashed=%s', (_name, output, expected) => {
    expect(hasHashedAssetFileNames(output)).toBe(expected);
  });
});
