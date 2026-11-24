import { parsePlatformAccessProtection } from '@void/platform';
import type { PlatformAccessProtection } from '@void/platform';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { boundedIdentityResponse } from './identity-network.ts';
import type { CompanyIdentity } from './sessions.ts';

export type PlatformAccessActor =
  | (CompanyIdentity & Readonly<{ kind: 'human'; email: string }>)
  | Readonly<{ kind: 'service'; issuer: string; serviceId: string }>;

export class PlatformAccessError extends Error {
  constructor() {
    super('A valid Cloudflare Access identity for this platform origin is required.');
    this.name = 'PlatformAccessError';
  }
}

/** Access verifies perimeter policy; Void additionally verifies the signed application assertion. */
export class PlatformAccessVerifier {
  private readonly keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly request: typeof fetch = (input, options) => fetch(input, options)) {}

  async verify(
    url: string,
    assertion: string | undefined,
    input: PlatformAccessProtection,
  ): Promise<PlatformAccessActor> {
    try {
      const protection = parsePlatformAccessProtection(input)!;
      const origin = new URL(url).origin;
      const application = protection.applications.find((entry) => entry.origin === origin);
      if (!application || !assertion || assertion.length > 32 * 1024) {
        throw new PlatformAccessError();
      }
      let keys = this.keys.get(protection.teamDomain);
      if (!keys) {
        if (this.keys.size >= 16) {
          this.keys.delete(this.keys.keys().next().value!);
        }
        keys = createRemoteJWKSet(new URL(`${protection.teamDomain}/cdn-cgi/access/certs`), {
          timeoutDuration: 10_000,
          [customFetch]: async (url, options) => {
            const response = await this.request(url, { ...options, redirect: 'manual' });
            if (response.redirected || (response.status >= 300 && response.status < 400)) {
              await response.body?.cancel();
              throw new PlatformAccessError();
            }
            return boundedIdentityResponse(response);
          },
        });
        this.keys.set(protection.teamDomain, keys);
      }
      const { payload } = await jwtVerify(assertion, keys, {
        issuer: protection.teamDomain,
        audience: application.audience,
        algorithms: ['RS256'],
        requiredClaims: ['iss', 'aud', 'iat', 'exp', 'sub', 'type'],
      });
      if (
        payload.type !== 'app' ||
        typeof payload.iat !== 'number' ||
        payload.iat > Date.now() / 1000 + 30
      ) {
        throw new PlatformAccessError();
      }
      if (Object.hasOwn(payload, 'common_name')) {
        if (
          payload.sub !== '' ||
          typeof payload.common_name !== 'string' ||
          !payload.common_name ||
          payload.email !== undefined
        ) {
          throw new PlatformAccessError();
        }
        return { kind: 'service', issuer: protection.teamDomain, serviceId: payload.common_name };
      }
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.sub.length > 255 ||
        typeof payload.email !== 'string' ||
        !payload.email ||
        payload.email.length > 320
      ) {
        throw new PlatformAccessError();
      }
      return {
        kind: 'human',
        issuer: protection.teamDomain,
        subject: payload.sub,
        email: payload.email,
      };
    } catch {
      // Do not expose provider responses, assertions, or untrusted JWT claims in an error.
      throw new PlatformAccessError();
    }
  }
}

export const platformAccessVerifier = new PlatformAccessVerifier();
