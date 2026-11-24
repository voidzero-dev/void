import { existsSync } from 'node:fs';
import { log, isCancel, select } from '@voidzero-dev/vite-plus-prompts';
import { basename, join } from 'pathslash';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
} from './cloudflare-auth.ts';
import type { CloudflareAccount } from './cloudflare-auth.ts';
import {
  LATEST_KNOWN_COMPAT_DATE,
  readRootWranglerConfig,
  writeProvisionedWranglerConfig,
} from './wrangler.ts';

export async function connectCloudflare(
  root: string,
  interactive: boolean = Boolean(process.stdin.isTTY),
): Promise<CloudflareAccount> {
  if (process.env.CLOUDFLARE_ENV || process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH) {
    throw new Error(
      'connect: Named Cloudflare environments and config overrides are not supported.',
    );
  }
  let existingConfig: ReturnType<typeof readRootWranglerConfig>;
  try {
    existingConfig = readRootWranglerConfig(root);
  } catch {
    throw new Error('connect: Invalid Cloudflare config. Fix it before connecting to Cloudflare.');
  }
  const existingConfigPath = existingConfig?.configPath;
  const config = existingConfig?.config ?? {};
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const configuredAccount = typeof config.account_id === 'string' ? config.account_id : undefined;
  if (envAccount && configuredAccount && envAccount !== configuredAccount) {
    throw new Error(
      'connect: The environment account differs from account_id in the Cloudflare config.',
    );
  }
  const pinnedAccount = configuredAccount || envAccount;
  const compatibilityDate =
    typeof config.compatibility_date === 'string'
      ? config.compatibility_date
      : LATEST_KNOWN_COMPAT_DATE;
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error(
      'connect: Found wrangler.toml. Convert it to wrangler.jsonc with the same settings before connecting to Cloudflare.',
    );
  }
  const { accounts } = await ensureCloudflareAuthentication({
    interactive,
    requireAccounts: true,
    runWrangler: createBundledCloudflareAuthRunner(root),
    configPath: existingConfigPath,
  });
  let account = accounts.find((entry) => entry.id === pinnedAccount);
  if (pinnedAccount && !account) {
    throw new Error(
      `connect: The signed-in Cloudflare session cannot access account ${pinnedAccount}.`,
    );
  }
  if (!account && accounts.length === 1) {
    account = accounts[0];
  }
  if (!account) {
    if (!interactive) {
      throw new Error(
        'connect: Multiple Cloudflare accounts are available. Set CLOUDFLARE_ACCOUNT_ID.',
      );
    }
    const id = await select({
      message: 'Choose a Cloudflare account:',
      initialValue: accounts[0]?.id,
      options: accounts.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.id })),
    });
    if (isCancel(id)) {
      throw new Error('connect: Cloudflare account selection was cancelled.');
    }
    account = accounts.find((entry) => entry.id === id);
  }
  if (!account) {
    throw new Error('connect: No Cloudflare account was selected.');
  }
  const written = writeProvisionedWranglerConfig(
    root,
    { accountId: account.id, compatibilityDate },
    existingConfigPath ? { configPath: existingConfigPath } : undefined,
  );
  log.info(`${basename(written.configPath)} is ready for Cloudflare deployment`);
  log.step(`Configured Cloudflare account: ${account.name}`);
  return account;
}
