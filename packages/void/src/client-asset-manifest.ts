import { compilePattern, matchPattern } from '@void/edge';
import type { Rolldown } from 'vite';
import type { ClientManifest } from './runtime/routing-assets.ts';
import type { RoutingHeaderRule } from './runtime/routing.ts';

/** Build facts that prove statically imported images are fingerprinted. */
export type ClientImageCacheProof = {
  /** Source files imported with `?image`, relative to the project root (client manifest keys). */
  imageSources: Iterable<string>;
  /**
   * The client build names every emitted asset from a string `assetFileNames`
   * template containing `[hash]` (see `hasHashedAssetFileNames`).
   */
  hashedAssetFileNames: boolean;
};

/**
 * Whether Rollup output options name every emitted asset with `[hash]`: Vite's
 * default template, or an authored string template that contains it. A
 * function template cannot be proven.
 */
export function hasHashedAssetFileNames(output: unknown): boolean {
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.every((options) => {
    const template = (options as { assetFileNames?: unknown } | undefined)?.assetFileNames;
    return template === undefined || (typeof template === 'string' && template.includes('[hash]'));
  });
}

/** Attach cache provenance to the existing manifest without changing its entry inventory. */
export function stampClientAssetCachePolicy(
  bundle: Rolldown.OutputBundle,
  manifestPath: string,
  headerRules: Array<RoutingHeaderRule> = [],
  images?: ClientImageCacheProof,
): void {
  const asset = bundle[manifestPath];
  if (asset?.type !== 'asset') {
    return;
  }
  const fingerprinted = new Set<string>();
  const authoredCachePatterns = headerRules
    .filter((rule) => rule.headers.some(([name]) => name.toLowerCase() === 'cache-control'))
    .map((rule) => rule.pattern);
  // A malformed pattern still fails the build.
  for (const pattern of authoredCachePatterns) {
    compilePattern(pattern);
  }
  for (const item of Object.values(bundle)) {
    // Chunks expose hash substitution provenance. Output assets (including CSS)
    // do not: an explicit stable fileName can match a configured [hash] template.
    // Preserve provider/authored policy for those assets instead of guessing.
    if (
      item.type === 'chunk' &&
      typeof item.preliminaryFileName === 'string' &&
      item.preliminaryFileName !== item.fileName
    ) {
      if (!authoredCachePatterns.some((pattern) => matchPattern(pattern, '/' + item.fileName))) {
        fingerprinted.add(item.fileName);
      }
    }
  }
  const manifest = JSON.parse(String(asset.source)) as ClientManifest;
  if (images?.hashedAssetFileNames) {
    // Images imported with `?image` are emitted by Vite's asset pipeline under
    // the proven [hash] template, so their manifest files are fingerprinted.
    // Other output assets stay unproven, as above.
    for (const source of images.imageSources) {
      const file = manifest[source]?.file;
      if (
        file &&
        bundle[file]?.type === 'asset' &&
        !authoredCachePatterns.some((pattern) => matchPattern(pattern, '/' + file))
      ) {
        fingerprinted.add(file);
      }
    }
  }
  for (const entry of Object.values(manifest)) {
    if (entry.file && fingerprinted.has(entry.file)) {
      entry.immutableFiles = [entry.file];
    } else {
      delete entry.immutableFiles;
    }
  }
  asset.source = JSON.stringify(manifest, null, 2);
}
