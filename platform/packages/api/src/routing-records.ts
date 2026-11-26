import { isRecord } from '@void/deploy-core';
import type { AssetConfig, HeaderRule, RedirectRule } from '@void/deploy-core';
import type { ProjectZeroTrustRouting } from '@void/edge';
import type { QueryAllowlist } from '@void/isr/core';
import type { PlatformApplicationProject } from '@void/platform';

export type RoutingEntry = Readonly<{
  workerName?: string;
  projectId: string;
  userId?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  // RAW per-path `routing.revalidate` OBJECT config (pages mode). Resolved at
  // the edge against the real request path for a matched inherit-eligible page
  // (a `pages` entry with no baked `revalidate`) — honors per-path `0` opt-outs
  // a dynamic pattern straddles. Distinct from the folded `revalidate` map.
  pathRevalidate?: Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  // `redirectRules` fires pre-asset, `fallbackRules` fires post-asset.
  // List identity encodes the pre-vs-post-asset semantic.
  redirectRules?: ReadonlyArray<RedirectRule>;
  alwaysUseHttps?: boolean;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  // Per-pathname allowlist of query params that are part of the ISR variant
  // key on a rewrite. Default (no entry / no allowlist) drops every param,
  // so an attacker can't fan out the cache by varying `?utm`/`?cb`/etc.
  queryAllowlist?: QueryAllowlist;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
  zeroTrust?: ProjectZeroTrustRouting;
  privatePreview?: boolean;
  hasCrons?: boolean;
}>;

export type QueueRoutingEntry = Readonly<{
  workerName: string;
  // Older entries did not carry the project id.
  projectId?: string;
  queueName: string;
  // HMAC-signed proxy token matching the user worker's __VOID_PROXY_TOKEN
  // binding. The framework-generated /__void/queue handler rejects relays
  // without a matching `x-void-internal` header with 401. Absent on entries
  // written by older API versions.
  proxyToken?: string;
}>;

function readRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number');
}

function isPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.pattern === 'string' &&
    (value.revalidate === undefined || typeof value.revalidate === 'number')
  );
}

function isHeaderRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.pattern === 'string' &&
    Array.isArray(value.headers) &&
    value.headers.every((pair: unknown) => isStringArray(pair) && pair.length === 2)
  );
}

function isRedirectRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.destination === 'string' &&
    typeof value.status === 'number' &&
    (value.host === undefined || typeof value.host === 'string')
  );
}

function isAssetConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { not_found_handling, html_handling, run_worker_first } = value;
  return (
    (not_found_handling === undefined ||
      not_found_handling === 'none' ||
      not_found_handling === 'single-page-application' ||
      not_found_handling === '404-page') &&
    (html_handling === undefined ||
      html_handling === 'none' ||
      html_handling === 'auto-trailing-slash' ||
      html_handling === 'force-trailing-slash' ||
      html_handling === 'drop-trailing-slash') &&
    (run_worker_first === undefined ||
      typeof run_worker_first === 'boolean' ||
      isStringArray(run_worker_first))
  );
}

function isZeroTrust(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.teamDomain === 'string' &&
    Array.isArray(value.audiences) &&
    value.audiences.every(
      (entry: unknown) =>
        isRecord(entry) && typeof entry.hostname === 'string' && typeof entry.audience === 'string',
    )
  );
}

function isRoutingEntry(value: Record<string, unknown>): value is RoutingEntry {
  const {
    type,
    revalidate,
    pages,
    pathRevalidate,
    limits,
    headerRules,
    redirectRules,
    fallbackRules,
    queryAllowlist,
    assetConfig,
    zeroTrust,
  } = value;
  return (
    typeof value.projectId === 'string' &&
    (typeof value.workerName === 'string' || typeof value.staticDeploymentId === 'string') &&
    (type === undefined ||
      type === 'void' ||
      type === 'spa' ||
      type === 'static' ||
      type === 'framework') &&
    [
      'workerName',
      'userId',
      'version',
      'suspended',
      'hashedAssetsPrefix',
      'staticDeploymentId',
      'assetManifestId',
    ].every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    ['ssr', 'alwaysUseHttps', 'privatePreview', 'hasCrons'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean',
    ) &&
    (revalidate === undefined || typeof revalidate === 'number' || isNumberMap(revalidate)) &&
    (pages === undefined || (Array.isArray(pages) && pages.every(isPage))) &&
    (pathRevalidate === undefined || isNumberMap(pathRevalidate)) &&
    (limits === undefined || isNumberMap(limits)) &&
    (headerRules === undefined ||
      (Array.isArray(headerRules) && headerRules.every(isHeaderRule))) &&
    (redirectRules === undefined ||
      (Array.isArray(redirectRules) && redirectRules.every(isRedirectRule))) &&
    (fallbackRules === undefined ||
      (Array.isArray(fallbackRules) && fallbackRules.every(isRedirectRule))) &&
    (queryAllowlist === undefined ||
      (isRecord(queryAllowlist) && Object.values(queryAllowlist).every(isStringArray))) &&
    (assetConfig === undefined || isAssetConfig(assetConfig)) &&
    (zeroTrust === undefined || isZeroTrust(zeroTrust))
  );
}

export function readRoutingEntry(raw: string): RoutingEntry | null {
  const value = readRecord(raw);
  return value && isRoutingEntry(value) ? value : null;
}

export function readQueueRoute(raw: string): QueueRoutingEntry | null {
  const value = readRecord(raw);
  if (!value) {
    return null;
  }
  const { workerName, queueName, projectId, proxyToken } = value;
  if (
    typeof workerName !== 'string' ||
    typeof queueName !== 'string' ||
    (projectId !== undefined && typeof projectId !== 'string') ||
    (proxyToken !== undefined && typeof proxyToken !== 'string')
  ) {
    return null;
  }
  return { workerName, queueName, projectId, proxyToken };
}

export function readProjectAlias(raw: string): PlatformApplicationProject | null {
  const value = readRecord(raw);
  return value && typeof value.id === 'string' && typeof value.slug === 'string'
    ? { id: value.id, slug: value.slug }
    : null;
}

function isServingAssetManifest(value: Record<string, unknown>): value is Record<string, string> {
  for (const path in value) {
    if (typeof value[path] !== 'string') {
      return false;
    }
  }
  return true;
}

export function readServingAssetManifest(raw: string): Record<string, string> | null {
  const value = readRecord(raw);
  return value && isServingAssetManifest(value) ? value : null;
}
