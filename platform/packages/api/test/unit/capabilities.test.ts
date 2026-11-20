import { describe, expect, it } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

// PLATFORM_CAPABILITIES as written by installers released before security audits.
const legacy = {
  ai: true,
  customDomains: true,
  email: true,
  githubActions: true,
  githubOAuth: true,
  googleOAuth: true,
  managedBuilds: true,
  sandbox: true,
};

describe('platform capabilities', () => {
  it('enables managed Sandbox when hosted configuration is absent', () => {
    expect(getPlatformCapabilities({})).toEqual({ ...legacy, securityAudits: false });
  });

  it('honors the installed platform Sandbox capability', () => {
    expect(getPlatformCapabilities({ PLATFORM_CAPABILITIES: JSON.stringify(legacy) }).sandbox).toBe(
      true,
    );
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });
});

describe('security audits capability', () => {
  it('keeps hosted security audits off', () => {
    expect(getPlatformCapabilities({}).securityAudits).toBe(false);
  });

  it('reads an installation written before security audits as off', () => {
    expect(
      getPlatformCapabilities({ PLATFORM_CAPABILITIES: JSON.stringify(legacy) }).securityAudits,
    ).toBe(false);
  });

  it('honors an installation that allows security audits', () => {
    expect(
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({ ...legacy, securityAudits: true }),
      }),
    ).toEqual({ ...legacy, securityAudits: true });
  });

  it.each(['true', 1, null])('rejects securityAudits %j', (securityAudits) => {
    expect(() =>
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({ ...legacy, securityAudits }),
      }),
    ).toThrow('PLATFORM_CAPABILITIES.securityAudits must be a boolean.');
  });
});
