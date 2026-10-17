import { imageConfigDefault, type ClientImageConfig, type ResolvedImageConfig } from './config.ts';

/**
 * The subset of the resolved config an `Image` reads at render time (Next.js
 * `__NEXT_IMAGE_OPTS`). Server environments always receive the patterns, for
 * the loader's query-string check; client bundles receive them only in
 * development, for the dev-time `src` checks.
 */
export function toClientImageConfig(
  resolved: ResolvedImageConfig,
  consumer: 'client' | 'server',
): ClientImageConfig {
  const config: ClientImageConfig = {
    deviceSizes: [...resolved.deviceSizes],
    imageSizes: [...resolved.imageSizes],
    allSizes: [...resolved.allSizes],
    qualities: [...resolved.qualities],
    path: resolved.path,
    loader: resolved.loader,
    dangerouslyAllowSVG: resolved.dangerouslyAllowSVG,
    unoptimized: resolved.unoptimized,
    dev: resolved.dev,
  };
  if (resolved.noOptimizer) {
    config.noOptimizer = true;
  }
  if (consumer === 'server' || resolved.dev) {
    config.localPatterns = resolved.localPatterns.map((p) => ({ ...p }));
    config.remotePatterns = resolved.remotePatterns.map((p) => ({ ...p }));
    config.domains = [...resolved.domains];
  }
  return config;
}

const ascending = (a: number, b: number): number => a - b;

/**
 * Next.js defaults in client form, without patterns (as `next/image` sees them
 * when no config is supplied). Used when no config is registered.
 */
export function defaultClientImageConfig(): ClientImageConfig {
  const deviceSizes = [...imageConfigDefault.deviceSizes].sort(ascending);
  const imageSizes = [...imageConfigDefault.imageSizes].sort(ascending);
  return {
    deviceSizes,
    imageSizes,
    allSizes: [...deviceSizes, ...imageSizes].sort(ascending),
    qualities: [...imageConfigDefault.qualities].sort(ascending),
    path: imageConfigDefault.path,
    loader: imageConfigDefault.loader,
    dangerouslyAllowSVG: imageConfigDefault.dangerouslyAllowSVG,
    unoptimized: imageConfigDefault.unoptimized,
    dev: false,
  };
}
