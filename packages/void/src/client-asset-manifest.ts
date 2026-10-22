import { compilePattern, matchPattern } from '@void/edge';
import type { Rolldown } from 'vite';
import type { ClientManifest } from './runtime/routing-assets.ts';
import type { RoutingHeaderRule } from './runtime/routing.ts';

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
