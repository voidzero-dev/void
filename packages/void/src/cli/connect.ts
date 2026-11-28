import type { PlatformDiscoveryDocument } from '@void/platform';
import { readPlatformToken } from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { connectCloudflare } from './cloudflare-connect.ts';
import type { ConnectArgs } from './connect-args.ts';
import { isCancel, log, select } from './interactive-prompts.ts';
import { promptForLoginToken } from './login.ts';
import { printSuccess } from './output.ts';
import { discoverPlatform, promptPlatformUrl, saveDiscoveredPlatform } from './platform-cmd.ts';
import { listPlatformConnections, normalizePlatformApiUrl } from './platform-registry.ts';
import {
  readDeploymentPlatform,
  writeDeploymentPlatform,
  writePlatformSelection,
} from './project.ts';

async function selectVoidPlatform(interactive: boolean): Promise<string> {
  if (!interactive) {
    throw new Error('connect: Supply a Void platform URL in non-interactive mode.');
  }
  const connections = listPlatformConnections();
  if (connections.length === 0) {
    return promptPlatformUrl();
  }
  const value = await select({
    message: 'Select a Void platform:',
    options: [
      ...connections.map((entry) => ({
        value: entry.apiUrl,
        label: entry.displayName,
        hint: entry.apiUrl,
      })),
      { value: 'new', label: 'Connect to another platform' },
    ],
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('connect: Cancelled.');
  }
  return value === 'new' ? promptPlatformUrl() : value;
}

export async function authenticateConnection(
  root: string,
  discovery: PlatformDiscoveryDocument,
  interactive: boolean,
): Promise<void> {
  // An environment token is usable only when explicitly bound to this origin.
  // Project metadata and another saved platform must never select its recipient.
  const envToken = process.env.VOID_TOKEN;
  const envUrl = process.env.VOID_API_URL;
  const matchingEnv = Boolean(
    envToken && envUrl && normalizePlatformApiUrl(envUrl) === discovery.apiUrl,
  );
  const token = matchingEnv ? envToken : readPlatformToken(discovery.apiUrl);
  if (token) {
    try {
      // Login must work on any platform version.
      await new PlatformClient(token, {
        apiUrl: discovery.apiUrl,
        checkPlatformVersion: false,
      }).whoami();
      log.step(`Authenticated with ${discovery.displayName}.`);
      return;
    } catch (error) {
      if (!isExpiredTokenError(error)) {
        throw error;
      }
      if (matchingEnv) {
        // oxlint-disable-next-line preserve-caught-error -- Credential errors are translated without including provider details.
        throw new Error('connect: VOID_TOKEN is invalid or expired. Replace it before connecting.');
      }
    }
  }
  if (!interactive) {
    throw new Error(
      'connect: Set VOID_TOKEN and a matching VOID_API_URL, or use --no-login to save the connection without authenticating.',
    );
  }
  await promptForLoginToken(root, discovery);
}

export async function runConnectCommand(
  root: string,
  args: ConnectArgs,
  interactive: boolean = Boolean(process.stdin.isTTY),
): Promise<void> {
  let target = args.platform ?? (args.url || args.noLogin ? 'void' : null);
  if (!target) {
    if (!interactive) {
      throw new Error('connect: Supply a platform URL or --platform cloudflare|void.');
    }
    const value = await select({
      message: 'Where should this project deploy?',
      initialValue: readDeploymentPlatform(root) === 'void' ? 'void' : 'cloudflare',
      options: [
        {
          value: 'cloudflare',
          label: 'Cloudflare',
          hint: 'Deploy to your own Cloudflare account.',
        },
        { value: 'void', label: 'Void', hint: "Deploy to your company's Void Platform." },
      ],
    });
    if (isCancel(value)) {
      throw new Error('connect: Cancelled.');
    }
    target = value as 'cloudflare' | 'void';
  }
  if (target === 'cloudflare') {
    await connectCloudflare(root, interactive);
    writeDeploymentPlatform(root, 'cloudflare');
    printSuccess('Connected to Cloudflare. Run `void deploy` to deploy this project.');
    return;
  }
  const discovery = await discoverPlatform(args.url || (await selectVoidPlatform(interactive)));
  if (!args.noLogin) {
    await authenticateConnection(root, discovery, interactive);
  }
  saveDiscoveredPlatform(discovery);
  const envUrl = process.env.VOID_API_URL;
  const environmentOverrides = Boolean(
    envUrl && normalizePlatformApiUrl(envUrl) !== discovery.apiUrl,
  );
  const selected = environmentOverrides ? false : writePlatformSelection(root, discovery);
  if (!selected) {
    log.info(
      'Saved the connection. The current project link or environment still selects its existing destination.',
    );
  }
  if (args.noLogin) {
    log.info(
      'Connection saved without login. Run `void account login` in a project using this platform when ready.',
    );
  } else if (selected) {
    log.info('Run `void project link` to select a project, then `void deploy`.');
  }
  printSuccess(`Connected to ${discovery.displayName} at ${discovery.apiUrl}.`);
}
