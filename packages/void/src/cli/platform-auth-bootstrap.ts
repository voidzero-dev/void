import { createHash, createHmac, randomBytes } from 'node:crypto';
import { parsePlatformAuthenticationSetup, PLATFORM_AUTH_SETUP_PROOF_PREFIX } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';

/** Checkpoint a replacement before submission so an interrupted response is safely replayable. */
export async function resumeInstalledPlatformAuthentication(
  input: {
    apiUrl: string;
    installationId: string;
    setupToken: string;
    setupJson: string;
    checkpoint: (replacement: {
      authenticationSetupJson: string;
      authBootstrapCode: string;
    }) => void;
  },
  initialize: typeof initializeInstalledPlatformAuthentication = initializeInstalledPlatformAuthentication,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const result = await initialize(
    input.apiUrl,
    input.installationId,
    input.setupToken,
    input.setupJson,
  );
  if (!result.setupPending || !result.expiresAt || Date.parse(result.expiresAt) > Date.now()) {
    return result;
  }
  const authBootstrapCode = randomBytes(32).toString('hex');
  const authenticationSetupJson = JSON.stringify({
    ...parsePlatformAuthenticationSetup(JSON.parse(input.setupJson)),
    resetPending: true,
    bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
  });
  input.checkpoint({ authenticationSetupJson, authBootstrapCode });
  return initialize(input.apiUrl, input.installationId, input.setupToken, authenticationSetupJson);
}

export async function initializeInstalledPlatformAuthentication(
  apiUrl: string,
  installationId: string,
  setupToken: string,
  setupJson: string,
  fetcher: typeof fetch = fetch,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const origin = normalizePlatformApiUrl(apiUrl);
  const setup = parsePlatformAuthenticationSetup(JSON.parse(setupJson));
  if (setup.protection) {
    ensurePlatformAccessToken(origin, false, true);
  }
  const body = JSON.stringify(setup);
  const signature = createHmac('sha256', setupToken)
    .update(`${PLATFORM_AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`)
    .digest('base64url');
  const response = await fetcher(`${origin}/internal/platform/auth-initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Auth-Setup': signature,
      ...cfAccessHeaders(process.env, origin),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `platform: Authentication setup failed (HTTP ${response.status}). Its outcome may be unknown; preserve the encrypted setup checkpoint and resume installation.`,
    );
  }
  const result = await response.json<{ setupPending?: unknown; expiresAt?: unknown }>();
  if (
    typeof result.setupPending !== 'boolean' ||
    (result.setupPending &&
      (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))))
  ) {
    throw new Error('platform: The platform returned an invalid authentication setup response.');
  }
  return {
    setupPending: result.setupPending,
    expiresAt: typeof result.expiresAt === 'string' ? result.expiresAt : null,
  };
}
