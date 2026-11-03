import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  extractWorkersDevSubdomain,
  normalizeReadinessAccessOrigin,
  normalizeWorkersDevSubdomain,
  type CloudflareWorkersDevSubdomainLookup,
} from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import type { DeployWranglerRun } from './deploy-types.ts';
import type { ComplianceRegion } from './provision.ts';

const STATE_FILE = join('.void', 'cloudflare.json');

type CloudflareLocalState = {
  workersDevSubdomain?: unknown;
  workersDevSubdomains?: unknown;
};

/** Resolve the account subdomain without exposing Cloudflare credentials to project code. */
export function resolveCloudflareWorkersDevSubdomain(
  root: string,
  accountId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = env.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (configured !== undefined && configured.trim().length > 0) {
    const normalized = normalizeWorkersDevSubdomain(configured);
    if (!normalized) {
      throw new Error(
        'deploy: CLOUDFLARE_WORKERS_SUBDOMAIN must be the account subdomain, for example "my-team" or "my-team.workers.dev".',
      );
    }
    return normalized;
  }

  const cached = subdomainsByAccount(readCloudflareLocalState(root))[accountId];
  return typeof cached === 'string' ? normalizeWorkersDevSubdomain(cached) : undefined;
}

/**
 * Record `CF_ACCESS_READINESS_ORIGIN` before project code runs. `void.config.ts` is evaluated in
 * this process, so a later read of `process.env` could see a value that the project assigned,
 * for example through a dotenv import. `null` means unset. An already recorded value is kept.
 */
export function withRecordedReadinessAccessOrigin<
  T extends { readinessAccessOrigin?: string | null },
>(options: T, env: Readonly<Record<string, string | undefined>> = process.env): T {
  return options.readinessAccessOrigin !== undefined
    ? options
    : { ...options, readinessAccessOrigin: env.CF_ACCESS_READINESS_ORIGIN ?? null };
}

/**
 * Validate the operator-selected origin that may receive readiness Access credentials when the
 * probe uses a route or Custom Domain. Pass the value that `withRecordedReadinessAccessOrigin`
 * recorded, not the current `process.env`.
 */
export function resolveCloudflareReadinessAccessOrigin(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = env.CF_ACCESS_READINESS_ORIGIN?.trim();
  if (!configured) {
    return undefined;
  }
  const origin = normalizeReadinessAccessOrigin(configured);
  if (!origin) {
    throw new Error(
      'deploy: CF_ACCESS_READINESS_ORIGIN must be one exact https origin, without a wildcard, path, query, fragment, or credentials, for example "https://app.example.com".',
    );
  }
  return origin;
}

/**
 * Read the account subdomain from the Cloudflare API when a first publish reports no URL and
 * no subdomain is configured or cached. The API returns only the account label, so this adds
 * `.fed` for FedRAMP High, as Wrangler does. A failed lookup resolves `unavailable`.
 */
export async function readCloudflareWorkersDevSubdomain(options: {
  configPath: string;
  complianceRegion: ComplianceRegion;
  runWrangler: DeployWranglerRun;
  verifyUploader: () => boolean;
}): Promise<CloudflareWorkersDevSubdomainLookup> {
  // The authenticated read runs in the pinned transport, keeping credentials in its process.
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  let label: string;
  try {
    const result = await options.runWrangler(
      { type: 'workers.subdomain.get', configPath: options.configPath },
      { capture: true },
    );
    if (
      !isCleanCloudflareExit(result) ||
      !result.data ||
      typeof result.data !== 'object' ||
      !('subdomain' in result.data) ||
      typeof result.data.subdomain !== 'string'
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    label = result.data.subdomain;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const subdomain = normalizeWorkersDevSubdomain(
    options.complianceRegion === 'fedramp_high' ? `${label}.fed` : label,
  );
  return subdomain ? { ok: true, subdomain } : { ok: false, reason: 'unavailable' };
}

/** Cache a Wrangler-reported account subdomain for later no-preview version probes. */
export function rememberCloudflareWorkersDevSubdomain(
  root: string,
  accountId: string,
  url: string,
): boolean {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  if (!workersDevSubdomain) {
    return false;
  }
  const current = readCloudflareLocalState(root);
  const currentByAccount = subdomainsByAccount(current);
  if (currentByAccount[accountId] === workersDevSubdomain) {
    return false;
  }
  const { workersDevSubdomain: _legacy, ...state } = current;
  const filePath = join(root, STATE_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...state,
        workersDevSubdomains: { ...currentByAccount, [accountId]: workersDevSubdomain },
      },
      null,
      2,
    ) + '\n',
  );
  return true;
}

function subdomainsByAccount(state: CloudflareLocalState): Record<string, unknown> {
  const value = state.workersDevSubdomains;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCloudflareLocalState(root: string): CloudflareLocalState {
  const filePath = join(root, STATE_FILE);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CloudflareLocalState)
      : {};
  } catch {
    return {};
  }
}
