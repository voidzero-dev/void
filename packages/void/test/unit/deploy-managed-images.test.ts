import { describe, expect, it } from 'vite-plus/test';
import { managedImageOptimizerWarning } from '../../src/cli/deploy-managed-full.ts';
import type { VoidConfig } from '../../src/config.ts';

const WARNING =
  "Image optimization isn't available on Void Platform yet, so Image serves original files.";

describe('managedImageOptimizerWarning', () => {
  it('warns when a Void app renders Image with the default loader', () => {
    expect(managedImageOptimizerWarning({ usesImageOptimizer: true }, {}, undefined)).toBe(WARNING);
  });

  it('does not warn when the app never renders Image', () => {
    expect(managedImageOptimizerWarning({ usesImageOptimizer: false }, {}, undefined)).toBe(
      undefined,
    );
    expect(managedImageOptimizerWarning({}, {}, undefined)).toBe(undefined);
  });

  it.each<[string, VoidConfig]>([
    ['unoptimized', { images: { unoptimized: true } }],
    ['a custom loader', { images: { loader: 'custom' } }],
    ['a loaderFile', { images: { loaderFile: './image-loader.ts' } }],
    ['the cloudflare loader', { images: { loader: 'cloudflare' } }],
    ['static output', { output: 'static' }],
    ['a Node target', { target: 'node' }],
  ])('does not warn with %s', (_name, config) => {
    expect(managedImageOptimizerWarning({ usesImageOptimizer: true }, config, undefined)).toBe(
      undefined,
    );
  });

  it('does not warn for framework apps', () => {
    expect(
      managedImageOptimizerWarning({ usesImageOptimizer: true }, {}, { name: 'astro', class: 'c' }),
    ).toBe(undefined);
  });
});
