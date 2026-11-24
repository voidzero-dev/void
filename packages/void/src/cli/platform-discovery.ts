import { parsePlatformDiscoveryDocument } from '@void/platform';
import type { PlatformDiscoveryDocument } from '@void/platform';
import { normalizePlatformApiUrl } from './platform-registry.ts';

/** Discovery was refused because the platform traffic gate is closed. */
export class PlatformDisabledError extends Error {
  /** True when an upgrade or repair paused traffic, not `void platform disable`. */
  readonly maintenance: boolean;

  constructor(message: string, maintenance = false) {
    super(message);
    this.name = 'PlatformDisabledError';
    this.maintenance = maintenance;
  }
}

/** Validates a `GET /.well-known/void-platform` response from `apiUrl`. */
export async function readPlatformDiscoveryResponse(
  apiUrl: string,
  response: Response,
): Promise<PlatformDiscoveryDocument> {
  if (!response.ok) {
    const message = `platform: Discovery failed at ${apiUrl} (HTTP ${response.status}).`;
    if (response.status === 503) {
      const body: unknown = await response.json().catch(() => null);
      if (
        body &&
        typeof body === 'object' &&
        (body as Record<string, unknown>).error === 'Platform disabled'
      ) {
        throw new PlatformDisabledError(
          message,
          (body as Record<string, unknown>).reason === 'maintenance',
        );
      }
    } else {
      await response.body?.cancel();
    }
    throw new Error(message);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`platform: ${apiUrl} returned invalid discovery metadata.`);
  }
  let discovery: PlatformDiscoveryDocument;
  try {
    discovery = parsePlatformDiscoveryDocument(value);
  } catch (error) {
    // oxlint-disable-next-line preserve-caught-error -- The discovery error message retains the relevant information without the raw response.
    throw new Error(
      `platform: ${apiUrl} returned invalid discovery metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const finalOrigin = normalizePlatformApiUrl(response.url ? new URL(response.url).origin : apiUrl);
  if (discovery.apiUrl !== finalOrigin) {
    throw new Error(
      `platform: Discovery origin mismatch. The response came from ${finalOrigin}, but identifies ${discovery.apiUrl}.`,
    );
  }
  return discovery;
}
