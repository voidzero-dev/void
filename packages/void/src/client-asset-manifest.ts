import { compilePattern, matchPattern } from '@void/edge';
import type { Rolldown } from 'vite';
import type { RoutingHeaderRule } from './runtime/routing/index.ts';
import { isClientManifest } from './shared/client-manifest.ts';

/**
 * Attach cache provenance to the existing manifest without changing its entry inventory.
 * Returns the stamped immutable files, sorted, relative to the client root.
 */
export function stampClientAssetCachePolicy(
  bundle: Rolldown.OutputBundle,
  manifestPath: string,
  headerRules: Array<RoutingHeaderRule> = [],
): Array<string> {
  const asset = bundle[manifestPath];
  if (asset?.type !== 'asset') {
    return [];
  }
  const source =
    typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
  const manifest: unknown = JSON.parse(source);
  if (!isClientManifest(manifest)) {
    throw new Error(`Invalid Vite client manifest in ${manifestPath}`);
  }
  const fingerprinted = new Set<string>();
  const authoredCachePatterns = headerRules.flatMap((rule) =>
    rule.headers.some(([name]) => name.toLowerCase() === 'cache-control') ? [rule.pattern] : [],
  );
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
  const stamped = new Set<string>();
  for (const entry of Object.values(manifest)) {
    if (entry.file && fingerprinted.has(entry.file)) {
      entry.immutableFiles = [entry.file];
      stamped.add(entry.file);
    } else {
      delete entry.immutableFiles;
    }
  }
  asset.source = JSON.stringify(manifest, null, 2);
  return [...stamped].sort();
}
