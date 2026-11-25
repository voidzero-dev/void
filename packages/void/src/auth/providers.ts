export const VOID_SOCIAL_AUTH_PROVIDERS = [
  'apple',
  'atlassian',
  'cognito',
  'discord',
  'dropbox',
  'facebook',
  'figma',
  'github',
  'gitlab',
  'google',
  'huggingface',
  'kakao',
  'kick',
  'line',
  'linear',
  'linkedin',
  'microsoft',
  'naver',
  'notion',
  'paybin',
  'paypal',
  'polar',
  'railway',
  'reddit',
  'roblox',
  'salesforce',
  'slack',
  'spotify',
  'tiktok',
  'twitch',
  'twitter',
  'vercel',
  'vk',
  'zoom',
] as const;

export const VOID_EMAIL_AUTH_PROVIDER = 'email';

export const VOID_AUTH_PROVIDERS: readonly [
  typeof VOID_EMAIL_AUTH_PROVIDER,
  ...typeof VOID_SOCIAL_AUTH_PROVIDERS,
] = [VOID_EMAIL_AUTH_PROVIDER, ...VOID_SOCIAL_AUTH_PROVIDERS] as const;

export type VoidSocialAuthProvider = (typeof VOID_SOCIAL_AUTH_PROVIDERS)[number];
export type VoidAuthProvider = (typeof VOID_AUTH_PROVIDERS)[number];

const VOID_SOCIAL_AUTH_PROVIDER_SET = new Set<string>(VOID_SOCIAL_AUTH_PROVIDERS);
const VOID_AUTH_PROVIDER_SET = new Set<string>(VOID_AUTH_PROVIDERS);

export function isVoidSocialAuthProvider(value: string): value is VoidSocialAuthProvider {
  return VOID_SOCIAL_AUTH_PROVIDER_SET.has(value);
}

export function isVoidAuthProvider(value: string): value is VoidAuthProvider {
  return VOID_AUTH_PROVIDER_SET.has(value);
}

/** Provider options other than the client credentials, with the env var that holds each one. */
const VOID_AUTH_PROVIDER_SETTING_ENV_NAMES: Partial<
  Record<VoidSocialAuthProvider, Record<string, string>>
> = {
  cognito: {
    domain: 'AUTH_COGNITO_DOMAIN',
    region: 'AUTH_COGNITO_REGION',
    userPoolId: 'AUTH_COGNITO_USER_POOL_ID',
  },
};

export function getVoidAuthProviderSettingEnvNames(
  provider: VoidSocialAuthProvider,
): Record<string, string> {
  return VOID_AUTH_PROVIDER_SETTING_ENV_NAMES[provider] ?? {};
}

type ProviderCredentialEnvNames = { clientId: string; clientSecret: string };

export function getVoidAuthProviderEnvNames(
  provider: VoidSocialAuthProvider,
): ProviderCredentialEnvNames {
  const normalized = provider.toUpperCase().replaceAll('-', '_');
  return {
    clientId: `AUTH_${normalized}_CLIENT_ID`,
    clientSecret: `AUTH_${normalized}_CLIENT_SECRET`,
  };
}
