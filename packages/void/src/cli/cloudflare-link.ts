import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  assertExistingCloudflareConfig,
  readExistingCloudflareWorker,
} from '@void/deploy-cloudflare';
import type {
  ExistingCloudflareWorker,
  CloudflareCommandRunner,
  ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { confirm, isCancel, log } from '@voidzero-dev/vite-plus-prompts';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { basename, join } from 'pathslash';
import { materializeCloudflareConfig, persistCloudflareConfig } from '../cloudflare-config.ts';
import { isUnchangedDeploySeed } from '../config-write.ts';
import { isVersionIdChain } from './cloudflare-candidate.ts';
import type { RunDeployOptions } from './deploy.ts';
import { discoverFrameworkWranglerFiles } from './framework-config-migrate.ts';
import { readDeploymentPlatform, writeDeploymentPlatform } from './project.ts';

const LINK_FILE = '.void/cloudflare-link.json';
export type CloudflareLink = {
  accountId: string;
  workerName: string;
  candidateReceipt?: {
    parentVersionId: string;
    versionIds: Array<string>;
  };
};

/** A pending handoff survives a failed build, so retrying cannot provision replacements. */
export function readCloudflareLink(root: string): CloudflareLink | null {
  const path = join(root, LINK_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      accountId?: unknown;
      workerName?: unknown;
      candidateReceipt?: { parentVersionId?: unknown; versionIds?: unknown };
    };
    if (
      typeof value.accountId === 'string' &&
      value.accountId &&
      typeof value.workerName === 'string' &&
      value.workerName
    ) {
      const link: CloudflareLink = { accountId: value.accountId, workerName: value.workerName };
      const receipt = value.candidateReceipt;
      if (receipt === undefined) {
        return link;
      }
      if (
        typeof receipt === 'object' &&
        receipt !== null &&
        typeof receipt.parentVersionId === 'string' &&
        receipt.parentVersionId.length > 0 &&
        isVersionIdChain(receipt.versionIds)
      ) {
        link.candidateReceipt = {
          parentVersionId: receipt.parentVersionId,
          versionIds: [...receipt.versionIds],
        };
        return link;
      }
    }
  } catch {
    /* Invalid state must never turn into an ordinary provisioning deploy. */
  }
  throw new Error(
    'The saved Cloudflare link is invalid. Restore .void/cloudflare-link.json before retrying.',
  );
}

export function saveCloudflareLink(root: string, link: CloudflareLink): void {
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(join(root, LINK_FILE), `${JSON.stringify(link)}\n`, { mode: 0o600 });
  writeDeploymentPlatform(root, 'cloudflare');
}

export function assertCloudflareLinkUnchanged(root: string, expected: CloudflareLink | null): void {
  if (!isDeepStrictEqual(readCloudflareLink(root), expected)) {
    throw new Error(
      'The pending Cloudflare handoff changed while project code was running. Restore .void/cloudflare-link.json and retry.',
    );
  }
}

/** Trust a failed candidate on retry only after this process validated its bindings and handlers. */
export function recordCloudflareCandidate(
  root: string,
  expectedLink: CloudflareLink,
  parentVersionId: string,
  versionId: string,
): void {
  assertCloudflareLinkUnchanged(root, expectedLink);
  if (
    expectedLink.candidateReceipt &&
    expectedLink.candidateReceipt.parentVersionId !== parentVersionId
  ) {
    throw new Error('The pending Cloudflare handoff changed before its candidate was recorded.');
  }
  const versionIds = [...(expectedLink.candidateReceipt?.versionIds ?? [])];
  if (!versionIds.includes(versionId)) {
    versionIds.push(versionId);
  }
  saveCloudflareLink(root, {
    ...expectedLink,
    candidateReceipt: { parentVersionId, versionIds },
  });
}

export function completeCloudflareLink(root: string): void {
  const path = join(root, LINK_FILE);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

type LinkedWorkerPatch = Partial<
  Pick<ExistingCloudflareWorker['runtime'], 'compatibility_date' | 'compatibility_flags' | 'limits'>
> & {
  account_id: string;
  keep_vars: boolean;
  version_metadata?: { binding: string };
};

export async function prepareExistingCloudflareDeploy(options: {
  root: string;
  configPath: string;
  accountId: string;
  reuse?: boolean;
  pinnedLink?: CloudflareLink | null;
  runWrangler: CloudflareCommandRunner;
  readExistingWorker?: typeof readExistingCloudflareWorker;
  approvedKv?: ReadonlyArray<ApprovedCloudflareKvBinding>;
}): Promise<ExistingCloudflareWorker | null> {
  if (options.pinnedLink !== undefined) {
    assertCloudflareLinkUnchanged(options.root, options.pinnedLink);
  }
  const pending =
    options.pinnedLink === undefined ? readCloudflareLink(options.root) : options.pinnedLink;
  if (!options.reuse && !pending) {
    return null;
  }
  const text = readFileSync(options.configPath, 'utf8');
  const config = parse(text) as Record<string, unknown> | null | undefined;
  if (
    typeof config?.name !== 'string' ||
    !config.name ||
    (pending && (pending.accountId !== options.accountId || pending.workerName !== config.name))
  ) {
    throw new Error(
      'The configured account or Worker differs from the existing Cloudflare link. Restore the original target before retrying.',
    );
  }
  const existing = await (options.readExistingWorker ?? readExistingCloudflareWorker)({
    runWrangler: options.runWrangler,
    configPath: options.configPath,
    workerName: config.name,
    accountId: options.accountId,
  });
  const patch: LinkedWorkerPatch = { account_id: options.accountId, keep_vars: true };
  // Native deploys may add version metadata only to their generated artifact.
  // Reuse the inspected binding when omitted; authored replacements still fail validation.
  const metadataBindings = existing.bindings.filter(
    (binding) => binding.type === 'version_metadata',
  );
  if (
    config.version_metadata === undefined &&
    metadataBindings.length === 1 &&
    typeof metadataBindings[0].name === 'string'
  ) {
    const metadata = { binding: metadataBindings[0].name };
    config.version_metadata = metadata;
    patch.version_metadata = metadata;
  }
  assertExistingCloudflareConfig(existing, config, false, options.approvedKv);
  let updated = text;
  for (const key of ['compatibility_date', 'compatibility_flags', 'limits'] as const) {
    if (config[key] === undefined && existing.runtime[key] !== undefined) {
      patch[key] = existing.runtime[key];
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    updated = applyEdits(
      updated,
      modify(updated, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  // Save the guard before the destination so a retry cannot enter provisioning unguarded.
  assertCloudflareLinkUnchanged(options.root, pending);
  const receipt = pending?.candidateReceipt;
  saveCloudflareLink(options.root, {
    accountId: options.accountId,
    workerName: config.name,
    ...(receipt?.parentVersionId === existing.versionId ? { candidateReceipt: receipt } : {}),
  });
  writeFileSync(options.configPath, updated);
  persistCloudflareConfig(options.root);
  return existing;
}

/** Offer the existing destination before the legacy hosted-platform fallback. */
export async function maybeLinkCloudflareDeploy(
  root: string,
  options: RunDeployOptions = {},
  deps: { interactive?: boolean; confirm?: typeof confirm } = {},
): Promise<'existing' | 'cancelled' | null> {
  if (
    options.platform ||
    options.projectSlug ||
    process.env.VOID_PROJECT ||
    readDeploymentPlatform(root) !== null
  ) {
    return null;
  }
  const files = [
    ...new Set([
      ...['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].filter((name) =>
        existsSync(join(root, name)),
      ),
      ...discoverFrameworkWranglerFiles(root),
    ]),
  ];
  const typedPath = join(root, 'void.config.ts');
  if (
    !files.length &&
    (!existsSync(typedPath) ||
      (!existsSync(join(root, 'void.lock.json')) &&
        isUnchangedDeploySeed(readFileSync(typedPath, 'utf8'))))
  ) {
    return null;
  }
  if (files.length > 1) {
    throw new Error(
      'Multiple Wrangler config files were found. Keep one root configuration before linking to Cloudflare.',
    );
  }
  const name = files[0] ?? '.void-wrangler.jsonc';
  if (name.endsWith('.toml')) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment currently needs a root wrangler.jsonc or wrangler.json with the same settings. Convert the config before linking.',
    );
  }
  const errors: Array<ParseError> = [];
  const configPath = files.length ? join(root, name) : materializeCloudflareConfig(root);
  const config = parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  }) as Record<string, unknown> | null | undefined;
  if (!files.length && (!config || typeof config.name !== 'string' || !config.name.trim())) {
    return null;
  }
  if (
    errors.length ||
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.name !== 'string' ||
    !config.name.trim()
  ) {
    throw new Error(
      `Set the existing Worker's name in a valid ${name} before linking to Cloudflare.`,
    );
  }
  if (!(deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error(
      `Found ${name} without a deployment destination. Run void deploy interactively to link the existing Worker, or use void deploy --platform cloudflare with Cloudflare credentials in CI.`,
    );
  }
  log.info(`Found ${basename(name)} for Worker "${config.name}".`);
  const accepted = await (deps.confirm ?? confirm)({
    message: 'Link this project and deploy to Cloudflare using the existing Worker and resources?',
    initialValue: true,
  });
  return isCancel(accepted) || accepted !== true ? 'cancelled' : 'existing';
}
