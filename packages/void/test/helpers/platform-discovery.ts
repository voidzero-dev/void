import { MIN_PLATFORM_VERSION } from '../../src/cli/client.ts';

const DISCOVERY_PATH = '/.well-known/void-platform';

/** Optional discovery fields. A field left out is absent, as on an older platform. */
export type PlatformDiscoveryFeatures = { directWorkerUpload?: unknown };

/** A valid discovery response for `apiUrl` that advertises `platformVersion`. */
export function platformDiscoveryResponse(
  apiUrl: string,
  platformVersion: string = MIN_PLATFORM_VERSION,
  features: PlatformDiscoveryFeatures = {},
): Response {
  const origin = new URL(apiUrl).origin;
  return Response.json({
    ...features,
    apiUrl: origin,
    applicationDomain: 'void.app',
    authenticationProviders: ['github'],
    capabilities: {
      ai: false,
      customDomains: false,
      email: false,
      githubActions: false,
      githubOAuth: true,
      googleOAuth: false,
      managedBuilds: false,
      sandbox: false,
    },
    displayName: 'Test platform',
    installationId: null,
    platformVersion,
    proxyUrl: origin,
    schemaVersion: 1,
  });
}

export function isPlatformDiscoveryRequest(input: unknown): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url).pathname === DISCOVERY_PATH;
}

/**
 * Wraps a fetch mock so the CLI's platform version check is answered here and
 * never reaches the mock. Call counts and queued responses stay unchanged.
 */
export function withPlatformDiscovery(
  fetchMock: unknown,
  platformVersion: string = MIN_PLATFORM_VERSION,
  features?: PlatformDiscoveryFeatures,
): typeof fetch {
  const next = fetchMock as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  return async (input, init) =>
    isPlatformDiscoveryRequest(input)
      ? platformDiscoveryResponse(
          input instanceof Request ? input.url : String(input),
          platformVersion,
          features,
        )
      : next(input, init);
}
