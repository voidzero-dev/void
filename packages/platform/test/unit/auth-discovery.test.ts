import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformDiscoveryDocument,
  parsePlatformDiscoveryDocument,
} from '../../src/discovery.ts';

const base = {
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
  applicationDomain: 'apps.example.com',
  installationId: 'installation',
  displayName: 'Example',
  platformVersion: '0.20.0',
  authenticationProviders: ['github'],
  capabilities: {
    ai: true,
    customDomains: false,
    email: false,
    githubActions: false,
    githubOAuth: true,
    googleOAuth: false,
    managedBuilds: false,
    sandbox: false,
  },
};
const modern = {
  ...base,
  authenticationProviders: ['company'],
  capabilities: { ...base.capabilities, githubOAuth: false },
  authentication: {
    methods: [{ id: 'company', kind: 'oidc' as const, label: 'Company SSO' }],
    protectedByAccess: false,
  },
};
describe('authentication discovery compatibility', () => {
  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'supports loopback discovery at %s',
    (apiUrl) => {
      const discovery = createPlatformDiscoveryDocument({ ...base, apiUrl, proxyUrl: apiUrl });
      expect(parsePlatformDiscoveryDocument(discovery).apiUrl).toBe(apiUrl);
    },
  );
  it.each(['http://localhost.example.com', 'http://127.0.0.2', 'http://example.com'])(
    'rejects insecure remote discovery at %s',
    (apiUrl) => {
      expect(() => createPlatformDiscoveryDocument({ ...base, apiUrl })).toThrow('HTTPS');
    },
  );
  it('retains the legacy document for unchanged installations', () => {
    const discovery = createPlatformDiscoveryDocument(base);
    expect(discovery.schemaVersion).toBe(1);
    expect(discovery).not.toHaveProperty('authentication');
    expect(parsePlatformDiscoveryDocument(discovery)).toEqual(discovery);
  });
  it('uses version 3 for named providers without requiring a perimeter gate', () => {
    const discovery = createPlatformDiscoveryDocument(modern);
    expect(discovery.schemaVersion).toBe(3);
    expect(parsePlatformDiscoveryDocument(discovery)).toEqual(discovery);
    expect(discovery.authentication?.protectedByAccess).toBe(false);
  });
  it('does not allow descriptors to disagree with advertised IDs or capability flags', () => {
    expect(() =>
      createPlatformDiscoveryDocument({ ...modern, authenticationProviders: ['another'] }),
    ).toThrow('match');
    expect(() =>
      createPlatformDiscoveryDocument({ ...modern, capabilities: base.capabilities }),
    ).toThrow('agree');
    expect(() =>
      createPlatformDiscoveryDocument({ ...base, authenticationProviders: ['custom'] }),
    ).toThrow('descriptors');
  });
  it('only permits an empty list when administrator setup is explicitly pending', () => {
    const input = {
      ...modern,
      authenticationProviders: [],
      authentication: { methods: [], protectedByAccess: true },
    };
    expect(() => createPlatformDiscoveryDocument(input)).toThrow('At least one');
    expect(
      createPlatformDiscoveryDocument({
        ...input,
        authentication: { ...input.authentication, setupPending: true },
      }).authentication?.setupPending,
    ).toBe(true);
  });
  it('rejects descriptor injection into old schema versions and strips unrecognized secret fields', () => {
    const document = createPlatformDiscoveryDocument(modern);
    expect(() =>
      parsePlatformDiscoveryDocument({
        ...document,
        schemaVersion: 1,
        authenticationProviders: ['github'],
      }),
    ).toThrow('schema version 3');
    const parsed = parsePlatformDiscoveryDocument({
      ...document,
      authentication: {
        ...document.authentication,
        clientSecret: 'hidden',
        methods: [
          {
            ...modern.authentication.methods[0],
            issuer: 'https://internal.example.com',
            clientSecret: 'hidden',
          },
        ],
      },
    });
    expect(JSON.stringify(parsed.authentication)).not.toContain('hidden');
    expect(JSON.stringify(parsed.authentication)).not.toContain('internal.example.com');
  });
});

describe('direct Worker upload discovery', () => {
  it('advertises direct Worker uploads on every document this platform serves', () => {
    for (const input of [base, modern]) {
      const discovery = createPlatformDiscoveryDocument(input);
      expect(discovery.directWorkerUpload).toBe(true);
      expect(parsePlatformDiscoveryDocument(discovery)).toEqual(discovery);
    }
  });

  it('reports only what an older platform said', () => {
    const { directWorkerUpload: _, ...older } = createPlatformDiscoveryDocument(base);
    expect(parsePlatformDiscoveryDocument(older)).not.toHaveProperty('directWorkerUpload');
    expect(
      parsePlatformDiscoveryDocument({ ...older, directWorkerUpload: false }).directWorkerUpload,
    ).toBe(false);
    expect(() => parsePlatformDiscoveryDocument({ ...older, directWorkerUpload: 'yes' })).toThrow(
      'directWorkerUpload must be a boolean.',
    );
  });
});
