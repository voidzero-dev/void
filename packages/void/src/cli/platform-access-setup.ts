import { stripVTControlCharacters } from 'node:util';
import { isPlatformAccessEmailDomain } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { confirm, log, multiselect, password, select, text } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { note, pc } from './output.ts';
import {
  PlatformAccessClient,
  PlatformAccessPolicyRejectedError,
  platformAccessIdentityProvider,
  platformAccessNonce,
  provisionPlatformAccess,
  verifySelectedAccessPolicies,
} from './platform-access-provision.ts';
import type {
  PlatformAccessCheckpoint,
  PlatformAccessProvisionResult,
} from './platform-access-provision.ts';
import { PlatformCloudflareApiError, PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';
import { platformPromptAnswer, platformSetupLink } from './platform-setup.ts';

function accessSetupGuide(): string {
  return platformSetupLink({
    title: 'Setup guide and required permissions',
    url: 'https://void.cloud/guide/platform/installation/setup#cloudflare-access',
  });
}

/** Parse up to ten exact company email domains, or return undefined when any entry is invalid. */
function companyEmailDomains(value: string): Array<string> | undefined {
  const domains = [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    ),
  ];
  return domains.length && domains.length <= 10 && domains.every(isPlatformAccessEmailDomain)
    ? domains
    : undefined;
}

export async function selectCompanyAccessPolicies(
  client: PlatformAccessClient,
  initialPolicies: Array<Record<string, unknown>>,
  accountId: string,
  mode: PlatformAccessSetupSpec['mode'],
  identityProviderIds: ReadonlyArray<string>,
): Promise<Array<string>> {
  const emailDomain = '__email_domain__';
  const create = '__create__';
  const refresh = '__refresh__';
  let policies = initialPolicies;
  let selectedIds: Array<string> = [];
  while (true) {
    const options = policies
      .filter(
        (policy) =>
          typeof policy.id === 'string' && ['allow', 'deny'].includes(String(policy.decision)),
      )
      .map((policy) => ({
        value: String(policy.id),
        label: stripVTControlCharacters(String(policy.name ?? policy.id)),
      }));
    const available = new Set(options.map((option) => option.value));
    selectedIds = selectedIds.filter((id) => available.has(id));
    const actions = [
      // Existing applications are managed elsewhere and need policies attached there.
      ...(mode === 'create'
        ? [
            {
              value: emailDomain,
              label: 'Allow my company’s email domain',
              hint: 'Void creates this Allow policy for you',
            },
          ]
        : []),
      {
        value: create,
        label: 'Create in Cloudflare',
        hint: 'Set up a policy in Cloudflare, then return here',
      },
      { value: refresh, label: 'Refresh list' },
    ];
    let choices: Array<string>;
    if (options.length === 0) {
      log.info(
        'No reusable Allow or Deny policies were found in this account. Create an Allow policy for your company, or refresh after saving one.',
      );
      choices = [
        platformPromptAnswer(
          await select({ message: 'Company Access policies:', options: actions }),
        ),
      ];
    } else {
      choices = platformPromptAnswer(
        await multiselect({
          message: 'Company Access policies (select all that apply):',
          options: [...options, ...actions],
          initialValues: selectedIds,
          required: true,
        }),
      );
    }
    selectedIds = choices.filter((id) => available.has(id));
    if (choices.includes(emailDomain)) {
      const domains = companyEmailDomains(
        platformPromptAnswer(
          await text({
            message: 'Company email domains (comma-separated):',
            placeholder: 'example.com',
            validate: (value) =>
              companyEmailDomains(value ?? '')
                ? undefined
                : 'Enter up to 10 email domains, such as example.com.',
          }),
        ),
      );
      if (!domains) {
        throw new Error('platform: Enter up to 10 email domains, such as example.com.');
      }
      const name = `Emails ending in @${domains[0]}${domains.length > 1 ? ` and ${domains.length - 1} more` : ''}`;
      try {
        // A lost response can lead to a second policy with the same name on retry. It
        // admits the same people, so the installer does not track or remove it.
        const created = (await client.create('policies', {
          name,
          decision: 'allow',
          include: domains.map((domain) => ({ email_domain: { domain } })),
        })) as { id?: unknown } | null;
        if (typeof created?.id === 'string' && created.id) {
          selectedIds.push(created.id);
        }
        log.info(
          `Created the Access policy “${name}” in Cloudflare. It stays there for reuse; you can add MFA or device rules to it later.`,
        );
      } catch (error) {
        if (!(error instanceof PlatformCloudflareApiError)) {
          throw error;
        }
        log.warn(`${error.message} Choose “Create in Cloudflare” instead.`);
      }
    } else if (choices.includes(create)) {
      note(
        [
          '1. Open Zero Trust → Access controls → Policies → Add a policy in this account.',
          '2. Name the policy and choose Allow.',
          '3. Include your company’s identity-provider group or Emails ending in your company domain, such as example.com.',
          '4. Require your selected company login method and your company’s MFA/device checks.',
          ...(mode === 'existing'
            ? [
                '5. Save the policy and attach it to the existing Access applications you’re connecting, then return here.',
              ]
            : ['5. Save the policy, then return here.']),
        ].join('\n'),
        pc.bold('Create an Access policy'),
      );
      console.log(
        platformSetupLink({
          title: 'Open Cloudflare account',
          url: `https://dash.cloudflare.com/${encodeURIComponent(accountId)}`,
        }),
      );
      const completed = platformPromptAnswer(
        await confirm({
          message: 'Have you saved the new policy?',
          initialValue: true,
        }),
      );
      if (!completed) {
        continue;
      }
    } else if (!choices.includes(refresh)) {
      try {
        await verifySelectedAccessPolicies(client, selectedIds, identityProviderIds);
        return selectedIds;
      } catch (error) {
        if (
          !(error instanceof PlatformAccessPolicyRejectedError) &&
          !(error instanceof PlatformCloudflareApiError && error.status === 404)
        ) {
          throw error;
        }
        log.warn(
          `${error.message.replace(/^platform: /, '')} Choose other policies, or fix the policy in Cloudflare and refresh the list.`,
        );
      }
    }
    policies = await client.list('policies');
  }
}

export function platformAccessResourceInventory(
  encoded: string | undefined,
  installationId: string,
): NonNullable<PlatformInstallationManifest['authenticationResources']> {
  if (!encoded) {
    return [];
  }
  const state = JSON.parse(encoded) as PlatformAccessCheckpoint;
  if (
    state.version !== 1 ||
    state.installationId !== installationId ||
    typeof state.accountId !== 'string' ||
    !state.resources
  ) {
    throw new Error('platform: Access resource recovery data belongs to another installation.');
  }
  return Object.entries(state.resources).flatMap(([key, resource]) =>
    resource.id
      ? [
          {
            key,
            kind: key.includes('service-token')
              ? ('service-token' as const)
              : ('application' as const),
            accountId: state.accountId,
            id: resource.id,
            name: resource.name,
            ownership: resource.adopted ? ('adopted' as const) : ('created' as const),
          },
        ]
      : [],
  );
}

export function checkpointPlatformAccessResources(
  manifest: PlatformInstallationManifest,
  encoded: string | undefined,
  updatedAt: string,
): PlatformInstallationManifest {
  const resources = platformAccessResourceInventory(encoded, manifest.id);
  const previous = manifest.authenticationResources ?? [];
  return resources.length
    ? {
        ...manifest,
        authenticationResources: [
          ...previous,
          ...resources.filter(
            (resource) =>
              !previous.some(
                (saved) =>
                  saved.accountId === resource.accountId &&
                  saved.kind === resource.kind &&
                  saved.id === resource.id,
              ),
          ),
        ],
        updatedAt,
      }
    : manifest;
}

export type PlatformAccessSetupSpec = {
  mode: 'create' | 'existing';
  accountId?: string;
  identityProviderIds?: Array<string>;
  policyIds?: Array<string>;
  loginApplicationId?: string;
  protectionApplicationId?: string;
  loginClientSecretEnv?: string;
  serviceToken?: { id: string; clientIdEnv: string; clientSecretEnv: string };
};

export function isPlatformAuthenticationPreparationKey(name: string): boolean {
  return (
    name.startsWith('authenticationConnection:') ||
    [
      'appAccessToken',
      'appAccessTokenRejected',
      'appAccessIdentityProviderIds',
      'appAccessPolicyIds',
      'accessManagementToken',
      'accessSetupSpecJson',
      'accessExistingServiceTokenJson',
      'accessExistingLoginSecret',
    ].includes(name)
  );
}

/** Validate before planning; credential references are resolved only during provisioning. */
export function parsePlatformAccessSetupSpec(input: unknown): PlatformAccessSetupSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('platform: cloudflareAccess must contain an Access setup configuration.');
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    'mode',
    'accountId',
    'identityProviderIds',
    'policyIds',
    'loginApplicationId',
    'protectionApplicationId',
    'loginClientSecretEnv',
    'serviceToken',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(
      'platform: Unknown Access setup field. Use environment references for credentials.',
    );
  }
  if (value.mode !== 'create' && value.mode !== 'existing') {
    throw new Error('platform: Access setup mode must be create or existing.');
  }
  for (const key of [
    'accountId',
    'loginApplicationId',
    'protectionApplicationId',
    'loginClientSecretEnv',
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !value[key] || String(value[key]).length > 256)
    ) {
      throw new Error(`platform: Invalid Access ${key}.`);
    }
  }
  for (const key of ['identityProviderIds', 'policyIds']) {
    const ids = value[key];
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > 16 ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
        new Set(ids).size !== ids.length)
    ) {
      throw new Error(`platform: Invalid Access ${key}.`);
    }
  }
  if (
    value.loginClientSecretEnv &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.loginClientSecretEnv))
  ) {
    throw new Error('platform: Invalid Access client secret environment reference.');
  }
  if (value.serviceToken !== undefined) {
    const token = value.serviceToken;
    if (
      !token ||
      typeof token !== 'object' ||
      Array.isArray(token) ||
      Object.keys(token).some((key) => !['id', 'clientIdEnv', 'clientSecretEnv'].includes(key))
    ) {
      throw new Error('platform: Access service tokens require an ID and environment references.');
    }
    const fields = token as Record<string, unknown>;
    if (
      typeof fields.id !== 'string' ||
      !fields.id ||
      fields.id.length > 256 ||
      ['clientIdEnv', 'clientSecretEnv'].some(
        (key) => typeof fields[key] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fields[key]),
      )
    ) {
      throw new Error('platform: Invalid Access service token environment references.');
    }
  }
  return value as PlatformAccessSetupSpec;
}

function secretReference(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !process.env[name]) {
    throw new Error('platform: Supply the referenced Access credential in the environment.');
  }
  return process.env[name];
}

/** Only scoped credentials for the reviewed platform origins enter the process environment. */
export function activatePlatformAccessCredentials(
  encoded: string | undefined,
  origins: ReadonlyArray<string>,
): void {
  if (encoded) {
    process.env.VOID_ACCESS_CREDENTIALS = mergePlatformAccessCredentials(encoded, origins);
  }
}

export function mergePlatformAccessCredentials(
  encoded: string,
  origins: ReadonlyArray<string>,
): string {
  const entries: unknown = JSON.parse(encoded);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('platform: Invalid saved Access credentials.');
  }
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  for (const [origin, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!allowed.has(origin) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'platform: Access credentials must be scoped to this platform’s API or proxy.',
      );
    }
    const headers = cfAccessHeaders(
      { VOID_ACCESS_CREDENTIALS: JSON.stringify({ [origin]: value }) },
      origin,
    );
    if (!Object.keys(headers).length) {
      throw new Error('platform: Saved Access credentials are incomplete.');
    }
  }
  const current: unknown = process.env.VOID_ACCESS_CREDENTIALS
    ? JSON.parse(process.env.VOID_ACCESS_CREDENTIALS)
    : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('platform: VOID_ACCESS_CREDENTIALS must contain an origin-keyed object.');
  }
  return JSON.stringify({ ...current, ...entries });
}

export async function preparePlatformAccessSetup(input: {
  plan: Pick<PlatformInstallPlan, 'account' | 'installationId' | 'apiUrl' | 'proxyUrl'>;
  additionalOrigins?: ReadonlyArray<string>;
  ownershipNonce: string;
  login?: { id: string; label: string; requiredGroups?: Array<string> };
  protection: boolean;
  spec?: PlatformAccessSetupSpec;
  client: PlatformCloudflareClient;
  checkpoint: Record<string, string>;
  save: (values: Record<string, string>) => void;
  yes: boolean;
}): Promise<PlatformAccessProvisionResult | undefined> {
  if (!input.login && !input.protection) {
    return undefined;
  }
  if (process.stdin.isTTY) {
    note(
      [
        input.login && input.protection
          ? 'Access lets employees sign in with your company login and controls who can reach the platform’s UI and APIs.'
          : input.login
            ? 'Access lets employees sign in to the platform with your company login.'
            : 'Access controls who can reach the platform’s UI and APIs.',
        '',
        'Void can create dedicated Access applications using your company’s existing login providers and policies, or use Access applications your company already manages.',
      ].join('\n'),
      pc.bold('Set up Cloudflare Access'),
    );
    console.log(accessSetupGuide());
  }
  let spec =
    input.spec ??
    (input.checkpoint.accessSetupSpecJson
      ? parsePlatformAccessSetupSpec(JSON.parse(input.checkpoint.accessSetupSpecJson))
      : undefined);
  if (!spec) {
    if (!process.stdin.isTTY) {
      if (input.protection) {
        throw new Error(
          'platform: Protection requires cloudflareAccess create or existing application verification in --auth-config.',
        );
      }
      return undefined;
    }
    const mode = platformPromptAnswer(
      await select({
        message: 'Cloudflare Access setup:',
        options: [
          {
            value: 'create',
            label: 'Create Access applications for this platform',
            hint: 'Use this account’s existing Zero Trust setup',
          },
          {
            value: 'existing',
            label: 'Use Access applications your company already manages',
            hint: 'May use another account',
          },
          ...(!input.protection
            ? [
                {
                  value: 'manual',
                  label: 'Connect an existing OIDC issuer without Cloudflare management access',
                },
              ]
            : []),
        ],
      }),
    );
    if (mode === 'manual') {
      return undefined;
    }
    spec = { mode: mode as 'create' | 'existing' };
    if (mode === 'existing') {
      log.info(
        'Enter the account that owns your company’s Access configuration. This may differ from the account hosting Void.',
      );
      spec.accountId = platformPromptAnswer(
        await text({
          message: 'Cloudflare identity account ID:',
          initialValue: input.plan.account.id,
        }),
      );
      if (input.login) {
        log.info('Enter the ID of the Access application that provides company sign-in to Void.');
        spec.loginApplicationId = platformPromptAnswer(
          await text({ message: 'Existing Access OIDC application ID:' }),
        );
      }
      if (input.protection) {
        log.info(
          'Enter the ID of the Access application that protects the platform’s UI and APIs.',
        );
        spec.protectionApplicationId = platformPromptAnswer(
          await text({ message: 'Existing Access protection application ID:' }),
        );
      }
    }
  }
  spec = parsePlatformAccessSetupSpec(spec);
  input.save({ accessSetupSpecJson: JSON.stringify(spec) });
  const accountId = spec.accountId ?? input.plan.account.id;
  const credential =
    process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN || input.checkpoint.accessManagementToken;
  let management = credential
    ? new PlatformCloudflareClient(credential, { apiBase: input.client.apiBaseUrl })
    : input.client;
  let client = new PlatformAccessClient(management, accountId);
  let providers: Array<Record<string, unknown>>;
  let policies: Array<Record<string, unknown>>;
  try {
    await client.get('organizations');
    providers = await client.list('identity_providers');
    policies = await client.list('policies');
  } catch (error) {
    if (
      !(error instanceof PlatformCloudflareApiError) ||
      ![401, 403].includes(error.status) ||
      !process.stdin.isTTY ||
      credential
    ) {
      throw error;
    }
    log.info(
      `Your current token lacks the required Access permissions for account ${accountId}. Create a token for that account using the permissions in the setup guide.`,
    );
    console.log(accessSetupGuide());
    const token = platformPromptAnswer(await password({ message: 'Access setup API token:' }));
    input.save({ accessManagementToken: token });
    management = new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl });
    client = new PlatformAccessClient(management, accountId);
    await client.get('organizations');
    providers = await client.list('identity_providers');
    policies = await client.list('policies');
  }
  if (!spec.identityProviderIds && process.stdin.isTTY) {
    log.info(
      'Choose how employees sign in—for example, your company’s Okta or Google Workspace connection.',
    );
  }
  const identityProviderIds =
    spec.identityProviderIds ??
    (process.stdin.isTTY
      ? platformPromptAnswer(
          await multiselect({
            message: 'Company identity providers:',
            required: true,
            options: providers
              .filter((provider) => typeof provider.id === 'string')
              .map(platformAccessIdentityProvider)
              .map((provider) => ({
                value: provider.id,
                label: stripVTControlCharacters(provider.name),
              })),
          }),
        )
      : []);
  if (identityProviderIds.length) {
    spec = { ...spec, identityProviderIds };
    input.save({ accessSetupSpecJson: JSON.stringify(spec) });
  }
  if (!spec.policyIds && process.stdin.isTTY) {
    log.info(
      'Choose which existing access rules apply to this platform, including MFA and device requirements.',
    );
  }
  const policyIds =
    spec.policyIds ??
    (process.stdin.isTTY
      ? await selectCompanyAccessPolicies(
          client,
          policies,
          accountId,
          spec.mode,
          identityProviderIds,
        )
      : []);
  if (!identityProviderIds.length || !policyIds.length) {
    throw new Error('platform: Access setup requires explicit identityProviderIds and policyIds.');
  }
  spec = { ...spec, identityProviderIds, policyIds };
  input.save({ accessSetupSpecJson: JSON.stringify(spec) });
  if (
    spec.mode === 'existing' &&
    ((input.login && !spec.loginApplicationId) ||
      (input.protection && !spec.protectionApplicationId))
  ) {
    throw new Error(
      'platform: Existing Access setup requires application IDs for each selected capability.',
    );
  }
  let serviceToken = spec.serviceToken
    ? {
        id: spec.serviceToken.id,
        clientId: secretReference(spec.serviceToken.clientIdEnv),
        clientSecret: secretReference(spec.serviceToken.clientSecretEnv),
      }
    : undefined;
  if (!serviceToken && spec.mode === 'existing' && input.protection) {
    if (input.checkpoint.accessExistingServiceTokenJson) {
      serviceToken = JSON.parse(input.checkpoint.accessExistingServiceTokenJson) as NonNullable<
        typeof serviceToken
      >;
    } else if (process.stdin.isTTY) {
      log.info(
        'This lets the installer reach the protected platform during setup. Use a service token allowed by the existing Access application.',
      );
      serviceToken = {
        id: platformPromptAnswer(
          await text({ message: 'Existing admitted Access service token ID:' }),
        ),
        clientId: platformPromptAnswer(
          await password({ message: 'Access service token client ID:' }),
        ),
        clientSecret: platformPromptAnswer(
          await password({ message: 'Access service token client secret:' }),
        ),
      };
      input.save({ accessExistingServiceTokenJson: JSON.stringify(serviceToken) });
    }
  }
  if (spec.mode === 'existing' && input.protection && !serviceToken) {
    throw new Error(
      'platform: Supply the service token already admitted by the existing protection application.',
    );
  }
  const reviewed = {
    accountId,
    login: input.login?.id ?? null,
    protection: input.protection,
    identityProviderIds,
    policyIds,
    origins: input.protection
      ? [input.plan.apiUrl, input.plan.proxyUrl, ...(input.additionalOrigins ?? [])]
      : [],
    mode: spec.mode,
  };
  console.log(JSON.stringify({ accessPlan: reviewed }, null, 2));
  if (!input.yes) {
    if (
      !process.stdin.isTTY ||
      !platformPromptAnswer(
        await confirm({ message: 'Apply this Access configuration?', initialValue: false }),
      )
    ) {
      throw new Error('platform: Access setup changes require confirmation or --yes.');
    }
  }
  const previous = input.checkpoint.accessProvisioningJson
    ? (JSON.parse(input.checkpoint.accessProvisioningJson) as PlatformAccessCheckpoint)
    : {
        version: 1 as const,
        accountId,
        installationId: input.plan.installationId,
        nonce: platformAccessNonce(input.ownershipNonce),
        resources: {},
      };
  let loginClientSecret = spec.loginClientSecretEnv
    ? secretReference(spec.loginClientSecretEnv)
    : input.checkpoint.accessExistingLoginSecret;
  if (input.login && spec.mode === 'existing' && !loginClientSecret && process.stdin.isTTY) {
    log.info('Enter the client secret from the existing Access login application’s OIDC settings.');
    loginClientSecret = platformPromptAnswer(
      await password({ message: 'Existing Access OIDC client secret:' }),
    );
    input.save({ accessExistingLoginSecret: loginClientSecret });
  }
  let provisioning = previous;
  const result = await provisionPlatformAccess(
    client,
    {
      accountId,
      installationId: input.plan.installationId,
      apiUrl: input.plan.apiUrl,
      proxyUrl: input.plan.proxyUrl,
      additionalOrigins: input.additionalOrigins,
      identityProviderIds,
      policyIds,
      ...(input.login
        ? {
            login: {
              ...input.login,
              applicationId: spec.loginApplicationId,
              ...(loginClientSecret ? { clientSecret: loginClientSecret } : {}),
            },
          }
        : {}),
      ...(input.protection ? { protection: { applicationId: spec.protectionApplicationId } } : {}),
      serviceToken,
    },
    previous,
    (state) => {
      provisioning = state;
      input.save({ accessProvisioningJson: JSON.stringify(state) });
    },
  ).catch((error: unknown): never => {
    if (!(error instanceof PlatformAccessPolicyRejectedError)) {
      throw error;
    }
    // A resume reuses saved picks, so a rejected pick would fail the same way every
    // time. Forget it so the next interactive run asks again, unless a configuration
    // file owns the pick or Access resources already depend on it.
    if (!input.spec && process.stdin.isTTY && !Object.keys(provisioning.resources).length) {
      const { identityProviderIds: _providers, policyIds: _policies, ...unpicked } = spec;
      input.save({ accessSetupSpecJson: JSON.stringify(unpicked) });
      throw new PlatformAccessPolicyRejectedError(
        `${error.message} Choose other policies when you run the command again, or fix the policy in Cloudflare.`,
        { cause: error },
      );
    }
    throw new PlatformAccessPolicyRejectedError(
      `${error.message} Fix the selected policy in Cloudflare, then resume.`,
      { cause: error },
    );
  });
  if (result.credentials) {
    const accessCredentialsJson = JSON.stringify(result.credentials);
    input.save({ accessCredentialsJson });
    activatePlatformAccessCredentials(accessCredentialsJson, [
      input.plan.apiUrl,
      input.plan.proxyUrl,
      ...(input.additionalOrigins ?? []),
    ]);
  }
  return result;
}
