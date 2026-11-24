import { log } from '@voidzero-dev/vite-plus-prompts';
import { basename } from 'pathslash';
import type { CloudflareArgs } from './cloudflare-args.ts';
import {
  createBundledCloudflareAuthRunner,
  cloudflareCredentialOverrides,
  ensureCloudflareAuthentication,
  parseCloudflareAuthSession,
} from './cloudflare-auth.ts';
import type { CloudflareAuthSession } from './cloudflare-auth.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import { printSuccess } from './output.ts';
import { readRootWranglerConfig } from './wrangler.ts';

export async function runCloudflareCommand(root: string, args: CloudflareArgs): Promise<void> {
  const runWrangler = createBundledCloudflareAuthRunner(root);
  switch (args.subcommand) {
    case 'login': {
      await ensureCloudflareAuthentication({ runWrangler, forceLogin: true });
      printSuccess('Successfully logged in to Cloudflare.');
      return;
    }
    case 'status': {
      const result = await runWrangler({ type: 'auth.whoami' }, true);
      const session = isCleanCloudflareExit(result)
        ? parseCloudflareAuthSession(result.data)
        : null;
      if (!session) {
        throw new Error('Not signed in to Cloudflare. Run `void cloudflare login`.');
      }
      log.info(formatSession(root, session));
      return;
    }
    case 'logout': {
      const result = await runWrangler({ type: 'auth.logout' }, true);
      if (result.status !== 0) {
        throw new Error('Could not remove the local Cloudflare browser session.');
      }
      const overrides = cloudflareCredentialOverrides();
      if (overrides.length > 0) {
        log.warn(
          `Removed the local Cloudflare browser session. Environment credentials remain active: ${overrides.join(', ')}.`,
        );
      } else {
        printSuccess('Signed out of Cloudflare.');
      }
      return;
    }
  }
}

function formatSession(root: string, session: CloudflareAuthSession): string {
  const lines = ['Signed in to Cloudflare.'];
  if (session.email) {
    lines.push(`User: ${session.email}`);
  }
  if (session.authType) {
    lines.push(`Authentication: ${session.authType}`);
  }
  const overrides = cloudflareCredentialOverrides();
  if (overrides.length > 0) {
    lines.push(`Environment credentials: ${overrides.join(', ')}`);
  }
  lines.push(
    'Accessible accounts:',
    ...(session.accounts.length > 0
      ? session.accounts.map((account) => `  ${account.name} (${account.id})`)
      : ['  No accessible accounts were returned.']),
  );

  try {
    const rootConfig = readRootWranglerConfig(root);
    const configured = rootConfig?.config.account_id;
    const environment = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
    const accountId = typeof configured === 'string' && configured ? configured : environment;
    if (accountId) {
      const source =
        accountId === configured
          ? basename(rootConfig!.configPath)
          : process.env.CLOUDFLARE_ACCOUNT_ID
            ? 'CLOUDFLARE_ACCOUNT_ID'
            : 'CF_ACCOUNT_ID';
      const account = session.accounts.find((account) => account.id === accountId);
      lines.push(
        `Deployment account: ${account ? `${account.name} (${accountId})` : accountId} (from ${source}).`,
      );
      if (!account) {
        lines.push(
          'The pinned deployment account was not returned by this authentication check. Signing in does not change the project target.',
        );
      }
      if (configured && environment && configured !== environment) {
        lines.push(
          'The environment account conflicts with the project configuration; resolve the mismatch before deploying.',
        );
      }
    } else {
      lines.push('Deployment account: not selected.');
    }
  } catch {
    lines.push(
      'Deployment account: unavailable because the Cloudflare configuration could not be read.',
    );
  }
  return lines.join('\n');
}
