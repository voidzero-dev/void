import type { PlatformApplication } from '@void/platform';
import { platformProjectHostnames } from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { resolveAccessAudience } from '../../../dispatch/src/access.ts';
import {
  normalizeZeroTrustConfigureInput,
  zeroTrustConfigurationStatus,
  zeroTrustWildcardDestinations,
} from '../../src/zero-trust/configuration.ts';
import type { ZeroTrustConfiguration } from '../../src/zero-trust/configuration.ts';

const application: PlatformApplication = {
  baseDomain: 'my-account.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev: { subdomain: 'my-account', installationId: 'team-123456abcdef' },
};

describe('Zero Trust wildcard destinations', () => {
  it('keeps domain-only installations scoped to their application domain', () => {
    expect(
      zeroTrustWildcardDestinations({
        baseDomain: 'apps.example.com',
        zoneName: 'example.com',
        dedicatedZone: false,
      }),
    ).toEqual(['*.apps.example.com']);
  });

  it('protects project forwarders without covering other account Workers', () => {
    const destinations = zeroTrustWildcardDestinations(application);
    expect(destinations).toEqual(['void-123456abcdef-*.my-account.workers.dev']);
    const routing = {
      teamDomain: 'https://team.cloudflareaccess.com',
      audiences: destinations.map((hostname) => ({ hostname, audience: 'project-aud' })),
    };
    for (const hostname of platformProjectHostnames(
      { id: 'proj_123abc', slug: 'blog' },
      application,
    )) {
      expect(resolveAccessAudience(hostname, routing)).toBe('project-aud');
    }
    for (const hostname of [
      'void-team-api.my-account.workers.dev',
      'void-team-proxy.my-account.workers.dev',
      'unrelated-worker.my-account.workers.dev',
      'void-fedcba654321-blog-123abc.my-account.workers.dev',
      'nested.void-123456abcdef-blog-123abc.my-account.workers.dev',
    ]) {
      expect(resolveAccessAudience(hostname, routing)).toBeNull();
    }
  });

  it('keeps existing project aliases protected when a domain becomes canonical', () => {
    const attached = { ...application, baseDomain: 'apps.example.com', zoneName: 'example.com' };
    const destinations = zeroTrustWildcardDestinations(attached);
    expect(destinations).toEqual([
      '*.apps.example.com',
      'void-123456abcdef-*.my-account.workers.dev',
    ]);
    const routing = {
      teamDomain: 'https://team.cloudflareaccess.com',
      audiences: destinations.map((hostname) => ({ hostname, audience: 'project-aud' })),
    };
    const hostnames = platformProjectHostnames({ id: 'proj_123abc', slug: 'blog' }, attached);
    expect(hostnames).toEqual([
      'blog.apps.example.com',
      'void-123456abcdef-blog-123abc.my-account.workers.dev',
    ]);
    expect(hostnames.map((hostname) => resolveAccessAudience(hostname, routing))).toEqual([
      'project-aud',
      'project-aud',
    ]);
  });
});

describe('Zero Trust configuration status', () => {
  const saved = {
    lastError: null,
    operation: null,
  } as unknown as ZeroTrustConfiguration;
  const operation = (kind: 'configure' | 'reconcile' | 'disable') =>
    ({ id: 'operation', kind }) as unknown as ZeroTrustConfiguration['operation'];

  it('derives the status from the saved operation and its last failure', () => {
    expect(zeroTrustConfigurationStatus(saved)).toBe('ready');
    expect(zeroTrustConfigurationStatus({ ...saved, operation: operation('configure') })).toBe(
      'configuring',
    );
    expect(zeroTrustConfigurationStatus({ ...saved, operation: operation('reconcile') })).toBe(
      'configuring',
    );
    expect(zeroTrustConfigurationStatus({ ...saved, operation: operation('disable') })).toBe(
      'disabling',
    );
    expect(
      zeroTrustConfigurationStatus({
        ...saved,
        operation: operation('disable'),
        lastError: 'Access token was revoked',
      }),
    ).toBe('error');
  });
});

describe('Zero Trust configure input', () => {
  const input = {
    apiToken: 'token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
  };

  it('leaves the existing-project choice optional and ignores an account id', () => {
    expect(normalizeZeroTrustConfigureInput({ ...input, accountId: 'other-account' })).toEqual(
      input,
    );
    expect(normalizeZeroTrustConfigureInput({ ...input, existingProjects: 'public' })).toEqual({
      ...input,
      existingProjects: 'public',
    });
    expect(() =>
      normalizeZeroTrustConfigureInput({ ...input, existingProjects: 'everything' }),
    ).toThrow('existingProjects must be protected or public');
  });
});
