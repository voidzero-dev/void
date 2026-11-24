import { createHmac } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  parsePlatformAppAccessSetup,
  PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX,
  PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX,
} from '@void/platform';
import type {
  PlatformAppAccess,
  PlatformAppAccessSetup,
  PlatformDeploymentManifest,
} from '@void/platform';
import { confirm, log, multiselect, password, select } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  PlatformAccessClient,
  platformAccessIdentityProvider,
  inspectPlatformAccess,
} from './platform-access-provision.ts';
import {
  parsePlatformAccessSetupSpec,
  selectCompanyAccessPolicies,
} from './platform-access-setup.ts';
import { PlatformCloudflareApiError, PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformAuthSelection } from './platform-install-auth.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';
import { openPlatformSetupPage, platformPromptAnswer } from './platform-setup.ts';

export async function selectInstallationAppAccess(
  authentication: PlatformAuthSelection,
  recorded?: PlatformDeploymentManifest,
  choice?: PlatformAppAccess,
): Promise<PlatformAppAccess | undefined> {
  const config = authentication.file?.appAccess;
  if (
    config &&
    (typeof config !== 'object' ||
      Array.isArray(config) ||
      'apiToken' in config ||
      (config.tokenEnv !== undefined &&
        (typeof config.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(config.tokenEnv))))
  ) {
    throw new Error(
      'platform: App access configuration must use tokenEnv; plaintext tokens are not accepted.',
    );
  }
  if (choice && config?.mode && choice !== config.mode) {
    throw new Error(
      'platform: --app-access conflicts with the authentication file’s app access choice.',
    );
  }
  const supplied = choice ?? config?.mode;
  if (supplied !== undefined && !['public', 'platform', 'custom'].includes(supplied)) {
    throw new Error('platform: App access must be public, platform, or custom.');
  }
  if (recorded) {
    if (supplied !== undefined && supplied !== recorded.appAccess) {
      throw new Error(
        'platform: Resume with the saved app access choice. Manage an installed platform’s app access in Admin → Zero Trust.',
      );
    }
    return recorded.appAccess;
  }
  const protectedPlatform = !!authentication.authentication.accessProtection;
  const selected =
    supplied ??
    (!process.stdin.isTTY
      ? protectedPlatform
        ? 'platform'
        : 'public'
      : platformPromptAnswer(
          await select({
            message: 'Who should be able to access deployed apps?',
            initialValue: protectedPlatform ? 'platform' : 'public',
            options: [
              ...(protectedPlatform
                ? [
                    {
                      value: 'platform' as const,
                      label: 'Same people allowed by the platform’s Access policy',
                      hint: 'recommended',
                    },
                  ]
                : []),
              { value: 'public' as const, label: 'Anyone — public apps' },
              {
                value: 'custom' as const,
                label: protectedPlatform
                  ? 'Choose a different Access policy'
                  : 'Set up Cloudflare Access protection',
              },
            ],
          }),
        ));
  if (selected === 'public' && (config?.identityProviderIds?.length || config?.policyIds?.length)) {
    throw new Error(
      'platform: Public apps cannot select identity policies. Choose custom app access to require company login.',
    );
  }
  if (selected === 'platform' && !protectedPlatform) {
    throw new Error(
      'platform: Reusing the platform Access policy requires --access-protection. Choose --app-access custom to protect apps separately.',
    );
  }
  return selected;
}

/** Collect the hosting-account policy once, with explicit consent for a durable management token. */
export async function prepareInstallationAppAccess(input: {
  plan: PlatformInstallPlan;
  authentication: PlatformAuthSelection;
  client: PlatformCloudflareClient;
  managementToken?: string;
  checkpoint: Record<string, string>;
  save: (values: Record<string, string>) => void;
}): Promise<string> {
  const choice = input.plan.deployment.appAccess;
  if (!choice) {
    throw new Error('platform: App access was not selected for this installation.');
  }
  const explicitToken =
    (input.authentication.file?.appAccess?.tokenEnv
      ? process.env[input.authentication.file.appAccess.tokenEnv]
      : undefined) || process.env.VOID_PLATFORM_APP_ACCESS_TOKEN;
  if (explicitToken && /\s/.test(explicitToken)) {
    throw new Error('platform: App access tokens must not contain whitespace.');
  }
  if (input.checkpoint.appAccessSetupJson && !input.checkpoint.appAccessTokenRejected) {
    const saved = parsePlatformAppAccessSetup(JSON.parse(input.checkpoint.appAccessSetupJson));
    if (
      saved.accountId !== input.plan.account.id ||
      saved.mode !== (choice === 'public' ? 'public' : 'protected')
    ) {
      throw new Error('platform: Saved app access belongs to another account or choice.');
    }
    if (saved.managed) {
      const refreshed = explicitToken
        ? JSON.stringify({ ...saved, apiToken: explicitToken })
        : input.checkpoint.appAccessSetupJson;
      input.save({ appAccessSetupJson: refreshed });
      return refreshed;
    }
    // Recheck an unmanaged public choice on resume: account-wide policy may have changed.
  }
  const file = input.authentication.file?.appAccess;
  let token =
    explicitToken ||
    (input.checkpoint.appAccessTokenRejected ? undefined : input.checkpoint.appAccessToken);
  if (input.checkpoint.appAccessTokenRejected) {
    log.info('The previous app access token was rejected. Provide a replacement to continue.');
  }
  const setupSpec = input.checkpoint.accessSetupSpecJson
    ? parsePlatformAccessSetupSpec(JSON.parse(input.checkpoint.accessSetupSpecJson))
    : input.authentication.file?.cloudflareAccess;
  const setupAccount = setupSpec?.accountId ?? input.plan.account.id;
  const reusable =
    setupAccount === input.plan.account.id
      ? process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN ||
        input.checkpoint.accessManagementToken ||
        input.managementToken
      : input.managementToken;
  const tokenPage = () =>
    openPlatformSetupPage({
      title: 'App access API token',
      url:
        'https://dash.cloudflare.com/?' +
        new URLSearchParams({
          to: `/${input.plan.account.id}/api-tokens`,
          name: `${input.plan.deployment.displayName} App Access`,
          permissionGroupKeys: JSON.stringify([
            { key: 'access', type: 'edit' },
            { key: 'access_acct', type: 'read' },
          ]),
        }),
      instructions: `Scope the token to ${input.plan.account.name}: Access Apps and Policies Edit; Organizations, Identity Providers, and Groups Read. Void stores it encrypted to manage app access.`,
    });
  const collectToken = async () => {
    if (!process.stdin.isTTY) {
      throw new Error(
        'platform: App access requires VOID_PLATFORM_APP_ACCESS_TOKEN or appAccess.tokenEnv in --auth-config, scoped to the hosting account.',
      );
    }
    tokenPage();
    const value = String(
      platformPromptAnswer(
        await password({
          message: 'App access API token (stored encrypted when app rules are needed):',
        }),
      ),
    ).trim();
    if (!value || /\s/.test(value)) {
      throw new Error('platform: An app access token without whitespace is required.');
    }
    input.save({ appAccessToken: value, appAccessTokenRejected: '' });
    return value;
  };
  if (!token && input.checkpoint.appAccessTokenRejected) {
    token = await collectToken();
  }
  // Public installations need only a read check unless the account enforces Default-Deny.
  let access = new PlatformAccessClient(
    token
      ? new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl })
      : input.client,
    input.plan.account.id,
  );
  let organization: Record<string, unknown> | null;
  const readOrganization = async () => {
    try {
      return (await access.get('organizations')) as Record<string, unknown>;
    } catch (error) {
      if (
        error instanceof PlatformCloudflareApiError &&
        (error.status === 404 ||
          (choice === 'public' &&
            error.status === 403 &&
            error.message.startsWith('Cloudflare API error: access.api.error.not_enabled:')))
      ) {
        return null;
      }
      throw error;
    }
  };
  try {
    organization = await readOrganization();
  } catch (error) {
    if (!(error instanceof PlatformCloudflareApiError) || ![401, 403].includes(error.status)) {
      throw error;
    }
    log.info('Check this account’s Access requirements before opening app traffic.');
    token = await collectToken();
    access = new PlatformAccessClient(
      new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl }),
      input.plan.account.id,
    );
    organization = await readOrganization();
  }
  const defaultDeny = organization?.deny_unmatched_requests === true;
  if (choice === 'public' && !defaultDeny) {
    const result = JSON.stringify({
      version: 1,
      accountId: input.plan.account.id,
      mode: 'public',
      managed: false,
      identityProviderIds: [],
      policyIds: [],
    } satisfies PlatformAppAccessSetup);
    input.save({ appAccessSetupJson: result });
    return result;
  }
  if (!organization) {
    throw new Error(
      `platform: Enable Zero Trust in account ${input.plan.account.name}, then resume to configure app access.`,
    );
  }
  if (!token) {
    log.info(
      'Void needs an Access-management token stored encrypted to manage access for future apps and custom domains.',
    );
    if (
      reusable &&
      process.stdin.isTTY &&
      platformPromptAnswer(
        await confirm({
          message: 'Reuse the setup token for ongoing app access management?',
          initialValue: true,
        }),
      )
    ) {
      token = reusable;
      input.save({ appAccessToken: token });
    } else {
      token = await collectToken();
    }
    access = new PlatformAccessClient(
      new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl }),
      input.plan.account.id,
    );
  }
  let identityProviderIds: Array<string> = [];
  let policyIds: Array<string> = [];
  if (choice !== 'public') {
    const reuse = choice === 'platform' && setupAccount === input.plan.account.id;
    if (choice === 'platform' && !reuse) {
      log.info(
        'The platform uses Access in another account. Choose equivalent identities and policies in the hosting account for apps.',
      );
    }
    identityProviderIds = input.checkpoint.appAccessIdentityProviderIds
      ? (JSON.parse(input.checkpoint.appAccessIdentityProviderIds) as Array<string>)
      : ((reuse ? setupSpec?.identityProviderIds : undefined) ?? file?.identityProviderIds ?? []);
    policyIds = input.checkpoint.appAccessPolicyIds
      ? (JSON.parse(input.checkpoint.appAccessPolicyIds) as Array<string>)
      : ((reuse ? setupSpec?.policyIds : undefined) ?? file?.policyIds ?? []);
    if (!identityProviderIds.length) {
      if (!process.stdin.isTTY) {
        throw new Error(
          'platform: Set appAccess.identityProviderIds in --auth-config for the hosting account.',
        );
      }
      const providers = (await access.list('identity_providers')).map(
        platformAccessIdentityProvider,
      );
      if (!providers.length) {
        throw new Error(
          `platform: Add an identity provider in Zero Trust for ${input.plan.account.name}, then resume.`,
        );
      }
      identityProviderIds = platformPromptAnswer(
        await multiselect({
          message: 'App identity providers:',
          required: true,
          options: providers.map((p) => ({ value: p.id, label: stripVTControlCharacters(p.name) })),
        }),
      );
      input.save({ appAccessIdentityProviderIds: JSON.stringify(identityProviderIds) });
    }
    if (!policyIds.length) {
      if (!process.stdin.isTTY) {
        throw new Error(
          'platform: Set appAccess.policyIds in --auth-config for the hosting account.',
        );
      }
      policyIds = await selectCompanyAccessPolicies(
        access,
        await access.list('policies'),
        input.plan.account.id,
        'create',
        identityProviderIds,
      );
      input.save({ appAccessPolicyIds: JSON.stringify(policyIds) });
    }
  } else {
    log.info(
      'This account requires Access. Void will create public rules scoped to app hostnames.',
    );
  }
  const setup = parsePlatformAppAccessSetup({
    version: 1,
    accountId: input.plan.account.id,
    mode: choice === 'public' ? 'public' : 'protected',
    managed: true,
    apiToken: token,
    identityProviderIds,
    policyIds,
  });
  if (setup.mode === 'protected') {
    try {
      await inspectPlatformAccess(access, setup);
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && [401, 403].includes(error.status)) {
        input.save({ appAccessTokenRejected: 'true' });
      } else {
        input.save({ appAccessIdentityProviderIds: '', appAccessPolicyIds: '' });
      }
      throw error;
    }
  }
  const result = JSON.stringify(setup);
  input.save({
    appAccessSetupJson: result,
    appAccessIdentityProviderIds: JSON.stringify(identityProviderIds),
    appAccessPolicyIds: JSON.stringify(policyIds),
    appAccessTokenRejected: '',
  });
  return result;
}

export class PlatformAppAccessCredentialError extends Error {}

/** Bounded, resumable handoff to the service that owns Zero Trust state. */
export async function initializeInstalledAppAccess(
  input: {
    apiUrl: string;
    installationId: string;
    probeToken: string;
    setupJson: string;
    setupToken: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  parsePlatformAppAccessSetup(JSON.parse(input.setupJson));
  if (!input.setupToken || input.setupToken.length < 32) {
    throw new Error('platform: Restore the encrypted app access setup authority before resuming.');
  }
  const signature = createHmac('sha256', input.setupToken)
    .update(
      `${PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX}\n${input.installationId}\n${input.setupJson}`,
    )
    .digest('base64url');
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetcher(new URL('/internal/platform/app-access', input.apiUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Void-Platform-Probe': input.probeToken,
        'X-Void-App-Access-Setup': signature,
        ...cfAccessHeaders(process.env, input.apiUrl),
      },
      body: input.setupJson,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 403) {
      const detail = await response.clone().text();
      if (/1050|Default-Deny/i.test(detail)) {
        throw new Error(
          `platform: Account Default-Deny blocks the platform API at ${input.apiUrl}. Configure Access for the platform API and its installer credentials, then resume.`,
        );
      }
    }
    let body: { ready?: boolean; installationId?: string; error?: string; code?: string };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Error(
        `platform: App access setup did not respond (HTTP ${response.status}). Check platform Access permissions and resume.`,
      );
    }
    if (body.code === 'app_access_credentials') {
      throw new PlatformAppAccessCredentialError(
        'App access token rejected. Resume installation to provide a replacement.',
      );
    }
    if (!response.ok || body.installationId !== input.installationId) {
      throw new Error(
        `platform: ${body.error || 'App access setup failed.'} Resume installation after correcting the Access configuration.`,
      );
    }
    if (body.ready) {
      return;
    }
  }
  throw new Error(
    'platform: App access setup is safely checkpointed. Resume installation to finish before app traffic opens.',
  );
}

/**
 * Turn off the project Zero Trust the installer enabled, for an uninstall
 * before any platform user exists. Signed with the app access setup authority
 * that turned it on.
 */
export async function turnOffInstalledProjectZeroTrust(
  input: {
    apiUrl: string;
    installationId: string;
    probeToken: string;
    setupToken: string;
    /** Deploys a runtime that has the turn-off route. */
    updateCommand: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify({ version: 1 });
  const signature = createHmac('sha256', input.setupToken)
    .update(`${PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX}\n${input.installationId}\n${body}`)
    .digest('base64url');
  const response = await fetcher(new URL('/internal/platform/app-access/turn-off', input.apiUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Platform-Probe': input.probeToken,
      'X-Void-App-Access-Setup': signature,
      ...cfAccessHeaders(process.env, input.apiUrl),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  let result: {
    turnedOff?: boolean;
    usersExist?: boolean;
    installationId?: string;
    error?: string;
    code?: string;
  } = {};
  try {
    result = (await response.json()) as typeof result;
  } catch {
    // Older runtimes answer an unknown route without a JSON body.
  }
  // An older runtime does not know the route: it answers 404, its traffic gate
  // answers 503 while the platform is disabled, and its Access check refuses
  // the installer's service token on routes it does not list.
  if (
    response.status === 404 ||
    (response.status === 503 && result.error === 'Platform disabled') ||
    (response.status === 403 && result.error === 'access_human_identity_required')
  ) {
    throw new Error(
      `platform: This platform runtime cannot turn off project Zero Trust before an administrator exists. Run \`${input.updateCommand}\`, then retry the uninstall.`,
    );
  }
  if (result.code === 'users_exist') {
    throw new Error(
      'platform: A platform user exists, so an administrator must turn off project Zero Trust. Run `void platform zero-trust disable`, then retry the uninstall.',
    );
  }
  if (result.code === 'app_access_credentials') {
    throw new Error(
      'platform: Cloudflare rejected the saved app access token, so Void cannot turn off project Zero Trust.',
    );
  }
  if (!response.ok || result.installationId !== input.installationId) {
    throw new Error(
      `platform: ${result.error || `Turning off project Zero Trust failed (HTTP ${response.status}).`}`,
    );
  }
  if (!result.turnedOff) {
    throw new Error('platform: Project Zero Trust is still turning off. Rerun the uninstall.');
  }
  if (result.usersExist) {
    throw new Error(
      'platform: A platform user signed in while project Zero Trust was turning off, so the uninstall stopped. Project Zero Trust is now off and the platform still runs. To keep the platform, an administrator can turn project Zero Trust back on in Admin → Zero Trust or with `void platform zero-trust configure`. To remove it, run the uninstall again.',
    );
  }
}
