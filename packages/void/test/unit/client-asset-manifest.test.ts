import type { Rolldown } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { stampClientAssetCachePolicy } from '../../src/client-asset-manifest.ts';

const MANIFEST = '.vite/manifest.json';

function chunk(fileName: string, preliminaryFileName: string): Rolldown.OutputChunk {
  return { type: 'chunk', fileName, preliminaryFileName } as Rolldown.OutputChunk;
}

function fakeBundle(): Rolldown.OutputBundle {
  const manifest = {
    'main.js': {
      file: 'assets/main-abcdefgh.js',
      isEntry: true,
      css: ['assets/main-12345678.css'],
    },
    '_shared.js': { file: 'assets/shared-12345678.js' },
    'stable.js': { file: 'assets/stable.js', immutableFiles: ['assets/stable.js'] },
    'covered.js': { file: 'assets/covered-abcdefgh.js' },
    'main.css': { file: 'assets/main-12345678.css' },
  };
  return {
    'assets/main-abcdefgh.js': chunk('assets/main-abcdefgh.js', 'assets/main-!~{001}~.js'),
    'assets/shared-12345678.js': chunk('assets/shared-12345678.js', 'assets/shared-!~{002}~.js'),
    'assets/stable.js': chunk('assets/stable.js', 'assets/stable.js'),
    'assets/covered-abcdefgh.js': chunk('assets/covered-abcdefgh.js', 'assets/covered-!~{003}~.js'),
    'assets/main-12345678.css': {
      type: 'asset',
      fileName: 'assets/main-12345678.css',
      source: 'body{}',
    },
    [MANIFEST]: { type: 'asset', fileName: MANIFEST, source: JSON.stringify(manifest) },
  } as unknown as Rolldown.OutputBundle;
}

describe('stampClientAssetCachePolicy', () => {
  it('returns the sorted hashed chunks it marks immutable', () => {
    const bundle = fakeBundle();
    const files = stampClientAssetCachePolicy(bundle, MANIFEST, [
      { pattern: '/assets/covered-*', headers: [['Cache-Control', 'public, max-age=60']] },
    ]);
    expect(files).toEqual(['assets/main-abcdefgh.js', 'assets/shared-12345678.js']);
    const manifest = JSON.parse(String((bundle[MANIFEST] as Rolldown.OutputAsset).source));
    const stamped = Object.values(manifest)
      .flatMap((entry) => (entry as { immutableFiles?: Array<string> }).immutableFiles ?? [])
      .sort();
    expect(stamped).toEqual(files);
    expect(manifest['stable.js']).not.toHaveProperty('immutableFiles');
  });

  it('returns no files without a manifest', () => {
    const bundle = fakeBundle();
    delete bundle[MANIFEST];
    expect(stampClientAssetCachePolicy(bundle, MANIFEST)).toEqual([]);
  });
});
