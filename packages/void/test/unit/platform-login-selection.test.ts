import { describe, expect, it } from 'vite-plus/test';
import { selectPlatformLoginMethod } from '../../src/cli/login.ts';
import type { LoginPlatform } from '../../src/cli/login.ts';

const platform: LoginPlatform = {
  apiUrl: 'https://platform.example.com',
  authenticationProviders: ['company'],
  authentication: {
    methods: [{ id: 'company', kind: 'oidc', label: 'Company SSO' }],
    protectedByAccess: false,
  },
};

describe('platform login selection', () => {
  it('selects the only named connection and retains its configured label', async () => {
    expect(await selectPlatformLoginMethod(platform)).toMatchObject({
      id: 'company',
      label: 'Company SSO',
    });
  });
  it('accepts an explicit enabled connection and rejects a disabled historical default', async () => {
    expect(await selectPlatformLoginMethod(platform, 'company')).toMatchObject({ id: 'company' });
    await expect(selectPlatformLoginMethod(platform, 'github')).rejects.toThrow('not enabled');
  });
  it('preserves legacy provider labels', async () => {
    expect(
      await selectPlatformLoginMethod({
        apiUrl: platform.apiUrl,
        authenticationProviders: ['google'],
      }),
    ).toEqual({ id: 'google', label: 'Google' });
  });
  it('explains pending administrator setup instead of defaulting to GitHub', async () => {
    await expect(
      selectPlatformLoginMethod({
        ...platform,
        authenticationProviders: [],
        authentication: { methods: [], protectedByAccess: false, setupPending: true },
      }),
    ).rejects.toThrow('finish initial setup');
  });
});
