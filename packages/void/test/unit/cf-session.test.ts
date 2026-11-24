import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCredentialStorageState,
  setKeyProviderFactoryForTesting,
} from '@cloudflare/workers-auth';
import {
  createCfAuth,
  createCfProfileStore,
  readUserPreferences,
  writeAuthConfigFile,
} from '@cloudflare/workers-auth/cf';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { persistCfKeyringPreference, readCfSessionCredential } from '../../src/cli/cf-session.ts';

let root: string;
const logger = { debug() {}, info() {}, log() {}, warn() {}, error() {} };
const authContext = {
  logger,
  userAgent: 'void-test',
  prompt: async () => {
    throw new Error('Unexpected prompt');
  },
  select: async () => {
    throw new Error('Unexpected prompt');
  },
  isNoDefaultValueProvidedError: () => false,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-cf-session-'));
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    vi.stubEnv(key, root);
  }
  vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'true');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
  vi.stubEnv('CF_API_TOKEN', '');
  clearCredentialStorageState();
  const keys = new Map<string, Uint8Array>();
  setKeyProviderFactoryForTesting((service, profile) => {
    const name = `${service}:${profile}`;
    return {
      getKey: () => keys.get(name),
      setKey: (key) => {
        keys.set(name, key);
      },
      deleteKey: () => {
        keys.delete(name);
      },
      describe: () => 'synthetic key provider',
    };
  });
});
afterEach(() => {
  setKeyProviderFactoryForTesting(undefined);
  clearCredentialStorageState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function stored(profile = 'default') {
  const auth = createCfAuth(authContext);
  auth.setProfile(profile);
  auth.writeAuthCredentials({
    oauth_token: `synthetic-${profile}`,
    refresh_token: 'synthetic-refresh',
    expiration_time: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: [],
  });
  const path = auth.getCredentialStore().path();
  expect(path).toMatch(/\.enc$/);
  expect(readFileSync(path, 'utf8')).not.toContain(`synthetic-${profile}`);
  return { authenticated: true, tokenValid: true, authSource: `OAuth token from ${path}` };
}

it('borrows a verified encrypted session and persists the store preference', () => {
  expect(readCfSessionCredential(root, stored())).toBe('synthetic-default');
  expect(readUserPreferences().keyring_enabled).toBe(true);
});

it('uses the named profile bound to the project, never another profile', () => {
  const other = stored();
  const team = stored('team');
  createCfProfileStore({ logger }).bindings.activate('team', root);
  expect(readCfSessionCredential(root, other)).toBeNull();
  expect(readCfSessionCredential(root, team)).toBe('synthetic-team');
});

it('does not borrow an invalid session or a different credential source', () => {
  const identity = stored();
  expect(readCfSessionCredential(root, { ...identity, tokenValid: false })).toBeNull();
  expect(readCfSessionCredential(root, { ...identity, authenticated: false })).toBeNull();
  expect(
    readCfSessionCredential(root, { ...identity, authSource: 'OAuth token from /untrusted/path' }),
  ).toBeNull();
});

it('adopts a legacy plaintext profile through Cloudflare encrypted storage', () => {
  writeAuthConfigFile({
    oauth_token: 'synthetic-legacy',
    refresh_token: 'synthetic-refresh',
    expiration_time: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: [],
  });
  const auth = createCfAuth(authContext);
  const path = auth.getCredentialStore().path();
  expect(
    readCfSessionCredential(root, {
      authenticated: true,
      tokenValid: true,
      authSource: `OAuth token from ${path}`,
    }),
  ).toBe('synthetic-legacy');
  expect(readFileSync(path, 'utf8')).not.toContain('synthetic-legacy');
  expect(readUserPreferences().keyring_enabled).toBe(true);
});

it('retains the encrypted preference for later compatible CLI logins', () => {
  stored();
  persistCfKeyringPreference(root);
  vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', undefined);
  expect(createCfAuth(authContext).getCredentialStore().kind).toBe('encrypted-file');
});

it('respects an explicit plaintext storage setting', () => {
  vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
  const auth = createCfAuth(authContext);
  auth.writeAuthCredentials({ oauth_token: 'synthetic-plaintext' });
  const path = auth.getCredentialStore().path();
  expect(path).not.toMatch(/\.enc$/);
  expect(
    readCfSessionCredential(root, {
      authenticated: true,
      tokenValid: true,
      authSource: `OAuth token from ${path}`,
    }),
  ).toBe('synthetic-plaintext');
  expect(readUserPreferences().keyring_enabled).not.toBe(true);
});
