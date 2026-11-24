import type { PlatformAuthenticationDiscovery } from '@void/platform';
import { outro, log, select, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import {
  getToken,
  getApiUrl,
  getTokenSource,
  removeToken,
  runPlatformLogin,
  savePlatformToken,
} from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { printSuccess, createSpinner, formatUrl, pc } from './output.ts';

export type LoginPlatform = {
  apiUrl: string;
  authenticationProviders: ReadonlyArray<string>;
  authentication?: PlatformAuthenticationDiscovery;
};

export async function selectPlatformLoginMethod(
  platform: LoginPlatform,
  requestedId?: string,
): Promise<{ id: string; label: string }> {
  const providers = platform.authenticationProviders;
  const methods =
    platform.authentication?.methods ??
    providers.map((id) => ({
      id,
      label: id === 'github' ? 'GitHub' : id === 'google' ? 'Google' : id,
    }));
  if (providers.length === 0) {
    throw new Error(
      platform.authentication?.setupPending
        ? 'auth: The platform administrator must finish initial setup.'
        : 'auth: This platform has no login providers.',
    );
  }
  if (requestedId) {
    const selected = methods.find((method) => method.id === requestedId);
    if (!selected) {
      throw new Error(`auth: Login method ${requestedId} is not enabled on this platform.`);
    }
    return selected;
  }
  const provider =
    providers.length === 1
      ? providers[0]
      : await select({
          message: 'Choose a login provider:',
          options: methods.map(({ id, label }) => ({
            value: id,
            label,
          })),
        });

  if (isCancel(provider) || typeof provider === 'symbol') {
    cancel('Login cancelled.');
    process.exit(0);
  }
  return methods.find((method) => method.id === provider)!;
}

export async function promptForLoginToken(
  root: string = process.cwd(),
  platform?: LoginPlatform,
): Promise<string> {
  const apiUrl = platform?.apiUrl ?? getApiUrl(root);
  const discovery =
    platform ?? (await (await import('./platform-cmd.ts')).discoverPlatform(apiUrl));
  const { id: provider, label: providerName } = await selectPlatformLoginMethod(discovery);
  const s = createSpinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const onUrl = (url: string) => {
      s.message(
        `Waiting for ${providerName} login. If your browser didn't open, visit:\n${pc.blue(formatUrl(url))}`,
      );
    };
    const token = await runPlatformLogin(apiUrl, provider, onUrl);
    savePlatformToken(token, apiUrl);
    s.stop('Logged in!');
    return token;
  } catch (err) {
    s.stop('Login failed');
    throw err;
  }
}

export async function runLoginCommand(root: string = process.cwd()): Promise<void> {
  console.log();

  const existing = getToken(root);
  let expiredEnvToken = false;
  if (existing) {
    const tokenSource = getTokenSource();
    // Login must work on any platform version.
    const client = new PlatformClient(existing, { root, checkPlatformVersion: false });
    try {
      await client.whoami();
      if (tokenSource === 'ci') {
        log.warn('Already authenticated via `VOID_TOKEN`.');
        outro('Unset `VOID_TOKEN` to log in with a different account.');
        return;
      }
      log.warn('Already logged in.');
      outro('To re-login, run `void account logout` first.');
      return;
    } catch (error) {
      if (!isExpiredTokenError(error)) {
        throw error;
      }

      if (tokenSource === 'ci') {
        expiredEnvToken = true;
        log.warn('`VOID_TOKEN` is invalid or expired. Continuing with a new login.');
      } else {
        removeToken(root);
        log.warn('Stored auth token expired. Starting a new login.');
      }
    }
  }

  await promptForLoginToken(root);
  if (expiredEnvToken) {
    printSuccess('Token saved. Unset `VOID_TOKEN` to use it.');
    return;
  }
  printSuccess('Token saved.');
}
