import type { ProjectZeroTrustRouting } from '@void/edge';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

function matchesHostname(pattern: string, hostname: string): boolean {
  const expected = pattern.toLowerCase();
  const actual = hostname.toLowerCase();
  const wildcard = expected.indexOf('*');
  if (wildcard === -1) {
    return expected === actual;
  }
  // Managed destinations use one wildcard at the end of the first label.
  const prefix = expected.slice(0, wildcard);
  const suffix = expected.slice(wildcard + 1);
  if (prefix.includes('.') || !suffix.startsWith('.') || suffix.includes('*')) {
    return false;
  }
  if (!actual.startsWith(prefix) || !actual.endsWith(suffix)) {
    return false;
  }
  const label = actual.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

export function resolveAccessAudience(
  hostname: string,
  routing: ProjectZeroTrustRouting,
): string | null {
  const exact = routing.audiences.find(
    (entry) => !entry.hostname.includes('*') && matchesHostname(entry.hostname, hostname),
  );
  if (exact) {
    return exact.audience;
  }
  return (
    routing.audiences.find((entry) => matchesHostname(entry.hostname, hostname))?.audience ?? null
  );
}

export class ProjectAccessVerifier {
  private readonly keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly request: typeof fetch = (input, options) => fetch(input, options)) {}

  async verify(
    hostname: string,
    assertion: string | null,
    routing: ProjectZeroTrustRouting,
  ): Promise<boolean> {
    try {
      const audience = resolveAccessAudience(hostname, routing);
      if (!audience || !assertion || assertion.length > 32 * 1024) {
        return false;
      }
      const teamDomain = routing.teamDomain.replace(/\/+$/, '');
      const url = new URL(teamDomain);
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.cloudflareaccess.com') ||
        url.origin !== teamDomain
      ) {
        return false;
      }
      let keys = this.keys.get(teamDomain);
      if (!keys) {
        if (this.keys.size >= 16) {
          const oldest = this.keys.keys().next();
          if (!oldest.done) {
            this.keys.delete(oldest.value);
          }
        }
        keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`), {
          timeoutDuration: 10_000,
          [customFetch]: async (input, init) => {
            const response = await this.request(input, { ...init, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              throw new Error('Access key endpoint redirected.');
            }
            return response;
          },
        });
        this.keys.set(teamDomain, keys);
      }
      const { payload } = await jwtVerify(assertion, keys, {
        issuer: teamDomain,
        audience,
        algorithms: ['RS256'],
        requiredClaims: ['iss', 'aud', 'iat', 'exp', 'type'],
      });
      return (
        payload.type === 'app' &&
        typeof payload.iat === 'number' &&
        payload.iat <= Date.now() / 1000 + 30
      );
    } catch {
      return false;
    }
  }
}

export const projectAccessVerifier = new ProjectAccessVerifier();
