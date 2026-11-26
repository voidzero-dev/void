import { describe, expect, it } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

describe('platform capabilities', () => {
  it('enables managed Sandbox when hosted configuration is absent', () => {
    expect(getPlatformCapabilities({})).toEqual({
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
      securityAudits: false,
    });
  });

  it('honors the installed platform Sandbox capability', () => {
    expect(
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({
          ai: true,
          customDomains: true,
          email: true,
          githubActions: true,
          githubOAuth: true,
          googleOAuth: true,
          managedBuilds: true,
          sandbox: true,
        }),
      }).sandbox,
    ).toBe(true);
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });

  it('reads a missing securityAudits as off and refuses a non-boolean', () => {
    const legacy = { ...getPlatformCapabilities({}), securityAudits: undefined };
    const read = (extra: Record<string, unknown>) =>
      getPlatformCapabilities({ PLATFORM_CAPABILITIES: JSON.stringify({ ...legacy, ...extra }) });
    expect(read({}).securityAudits).toBe(false);
    expect(read({ securityAudits: true }).securityAudits).toBe(true);
    expect(() => read({ securityAudits: 'true' })).toThrow('securityAudits must be a boolean');
  });
});
