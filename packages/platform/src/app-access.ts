export const PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX = 'void-platform-app-access-v1';
/** Uninstall handoff that turns off installer-managed project Zero Trust before any user exists. */
export const PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX = 'void-platform-app-access-turn-off-v1';

/** Installer handoff. Token values belong only in encrypted recovery and request bodies. */
export type PlatformAppAccessSetup = Readonly<{
  version: 1;
  accountId: string;
  mode: 'public' | 'protected';
  managed: boolean;
  apiToken?: string;
  identityProviderIds: ReadonlyArray<string>;
  policyIds: ReadonlyArray<string>;
}>;

export function parsePlatformAppAccessSetup(value: unknown): PlatformAppAccessSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid app access setup.');
  }
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !['public', 'protected'].includes(String(input.mode)) ||
    typeof input.managed !== 'boolean' ||
    typeof input.accountId !== 'string' ||
    !input.accountId
  ) {
    throw new Error('Invalid app access setup.');
  }
  const ids = (name: string): Array<string> => {
    const entries = input[name];
    if (
      !Array.isArray(entries) ||
      entries.length > 16 ||
      !entries.every(
        (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 128,
      ) ||
      new Set(entries).size !== entries.length
    ) {
      throw new Error(`Invalid app access ${name}.`);
    }
    return [...entries];
  };
  const identityProviderIds = ids('identityProviderIds');
  const policyIds = ids('policyIds');
  if (
    input.mode === 'protected' &&
    (!input.managed || !identityProviderIds.length || !policyIds.length)
  ) {
    throw new Error(
      'Protected apps require identity providers, policies, and an Access-management token.',
    );
  }
  if (input.mode === 'public' && (identityProviderIds.length || policyIds.length)) {
    throw new Error('Public app access cannot include identity policies.');
  }
  if (
    input.managed
      ? typeof input.apiToken !== 'string' ||
        !input.apiToken.trim() ||
        /\s/.test(input.apiToken) ||
        input.apiToken.length > 8192
      : input.apiToken !== undefined
  ) {
    throw new Error(
      'Managed app access requires a token; unmanaged public access must not retain one.',
    );
  }
  return {
    version: 1,
    accountId: input.accountId,
    mode: input.mode as PlatformAppAccessSetup['mode'],
    managed: input.managed,
    ...(input.managed ? { apiToken: input.apiToken as string } : {}),
    identityProviderIds,
    policyIds,
  };
}
