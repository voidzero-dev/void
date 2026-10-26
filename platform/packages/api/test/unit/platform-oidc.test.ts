import { parsePlatformLoginConfiguration } from '@void/platform';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { assertPublicIdentityUrl, PlatformOidcProvider } from '../../src/auth/oidc.ts';

let key: CryptoKey;
let jwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'first', use: 'sig', alg: 'ES256' };
});

function fixture(
  options: {
    configuration?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    signingKey?: CryptoKey;
    kid?: string;
    keys?: Array<Record<string, unknown>>;
  } = {},
) {
  const configuration = parsePlatformLoginConfiguration({
    id: 'company',
    kind: 'oidc',
    label: 'Company',
    issuer: 'https://identity.example.com',
    clientId: 'void-client',
    ...options.configuration,
  });
  const issuer = configuration.issuer!;
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    ...options.metadata,
  };
  let nonce: string;
  let verifier: string;
  const redirectUri = 'https://api.example.com/auth/callback';
  const request = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json(metadata);
    }
    if (url === metadata.token_endpoint) {
      const body = init.body as URLSearchParams;
      expect(body.get('code_verifier')).toBe(verifier);
      expect(body.get('redirect_uri')).toBe(redirectUri);
      expect(body.get('client_secret')).toBe('client-secret');
      const token = await new SignJWT({
        nonce,
        email: 'person@example.com',
        email_verified: true,
        iss: issuer,
        aud: configuration.clientId,
        sub: 'person-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        ...options.claims,
      })
        .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'first' })
        .sign(options.signingKey ?? key);
      return Response.json({
        access_token: 'temporary-access-token',
        token_type: 'Bearer',
        id_token: token,
      });
    }
    if (url === metadata.jwks_uri) {
      return Response.json({ keys: options.keys ?? [jwk] });
    }
    throw new Error('Unexpected identity request');
  });
  const provider = new PlatformOidcProvider(configuration, request);
  return {
    provider,
    request,
    async start() {
      const result = await provider.authorize(redirectUri, 'browser-bound-state');
      nonce = result.nonce;
      verifier = result.verifier;
      return result;
    },
    exchange(state = 'browser-bound-state') {
      return provider.exchange({
        callback: new URL(`${redirectUri}?code=one-time-code&state=${state}`),
        redirectUri,
        state: 'browser-bound-state',
        nonce,
        verifier,
        clientSecret: 'client-secret',
      });
    },
  };
}

describe('platform OIDC', () => {
  it('uses nonce and upstream PKCE, validates the signed identity, and caches discovery', async () => {
    const server = fixture();
    const start = await server.start();
    const url = new URL(start.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe(start.nonce);
    expect(url.searchParams.get('state')).toBe('browser-bound-state');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.href).not.toContain(start.verifier);
    expect(await server.exchange()).toEqual({
      issuer: 'https://identity.example.com',
      subject: 'person-123',
      login: 'person@example.com',
      email: 'person@example.com',
      emailVerified: true,
      groups: [],
    });
    expect(
      server.request.mock.calls.filter(([url]) => url.endsWith('openid-configuration')),
    ).toHaveLength(1);
    expect(server.request.mock.calls.some(([url]) => url.endsWith('/jwks'))).toBe(true);
  });

  it.each([
    { nonce: 'other-browser' },
    { aud: 'another-client' },
    { iss: 'https://another.example.com' },
    { exp: 1 },
    { sub: '' },
  ])('rejects invalid identity claims %j', async (claims) => {
    const server = fixture({ claims });
    await server.start();
    await expect(server.exchange()).rejects.toThrow();
  });

  it('rejects wrong state before transmitting the authorization code or client secret', async () => {
    const server = fixture();
    await server.start();
    await expect(server.exchange('other-state')).rejects.toThrow();
    expect(server.request).toHaveBeenCalledTimes(1);
  });

  it('checks the signature even though the ID token came from the HTTPS token endpoint', async () => {
    const other = await generateKeyPair('ES256');
    const server = fixture({ signingKey: other.privateKey });
    await server.start();
    await expect(server.exchange()).rejects.toThrow();
  });

  it('does not equate an email claim with verification', async () => {
    const server = fixture({ claims: { email_verified: 'true' } });
    await server.start();
    expect((await server.exchange()).emailVerified).toBe(false);
  });

  it('refreshes signing keys after the provider rotates them', async () => {
    const options: Parameters<typeof fixture>[0] = {};
    const server = fixture(options);
    await server.start();
    await server.exchange();
    const next = await generateKeyPair('ES256', { extractable: true });
    options.signingKey = next.privateKey;
    options.kid = 'second';
    options.keys = [
      { ...(await exportJWK(next.publicKey)), kid: 'second', alg: 'ES256', use: 'sig' },
    ];
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await server.exchange()).subject).toBe('person-123');
      expect(server.request.mock.calls.filter(([url]) => url.endsWith('/jwks'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports identities without email', async () => {
    const server = fixture({ claims: { email: undefined, email_verified: undefined } });
    await server.start();
    expect(await server.exchange()).toMatchObject({
      login: 'person-123',
      email: null,
      emailVerified: false,
    });
  });

  it('enforces configured groups and asks for the group scope', async () => {
    const server = fixture({
      configuration: { requiredGroups: ['employees'] },
      claims: { groups: ['contractors'] },
    });
    expect(new URL((await server.start()).url).searchParams.get('scope')).toContain('groups');
    await expect(server.exchange()).rejects.toThrow('allowed group');
    const accepted = fixture({
      configuration: { requiredGroups: ['employees'] },
      claims: { groups: ['employees'] },
    });
    await accepted.start();
    expect((await accepted.exchange()).groups).toEqual(['employees']);
  });

  it('checks Google hd rather than an email suffix or the authorization hint', async () => {
    const config = {
      id: 'google',
      kind: 'google',
      issuer: 'https://accounts.google.com',
      allowedDomains: ['example.com'],
    };
    const server = fixture({ configuration: config });
    expect(new URL((await server.start()).url).searchParams.get('hd')).toBe('example.com');
    await expect(server.exchange()).rejects.toThrow('Workspace domain');
    const accepted = fixture({ configuration: config, claims: { hd: 'example.com' } });
    await accepted.start();
    expect((await accepted.exchange()).subject).toBe('person-123');
  });

  it('sends client credentials unescaped in the form body when the provider supports it', async () => {
    const clientId = '761060634857-abc_def.apps.googleusercontent.com';
    const server = fixture({
      configuration: {
        id: 'google',
        kind: 'google',
        issuer: 'https://accounts.google.com',
        clientId,
      },
      metadata: {
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      },
    });
    await server.start();
    await server.exchange();
    const [, init] = server.request.mock.calls.find(([url]) => url.endsWith('/token'))!;
    expect((init.body as URLSearchParams).get('client_id')).toBe(clientId);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('names each login failure with a short code', async () => {
    await expect(
      fixture({ metadata: { issuer: 'https://other.example.com' } }).start(),
    ).rejects.toMatchObject({ code: 'oidc_discovery_failed' });

    const denied = fixture();
    await denied.start();
    await expect(
      denied.provider.exchange({
        callback: new URL(
          'https://api.example.com/auth/callback?error=access_denied&state=browser-bound-state',
        ),
        redirectUri: 'https://api.example.com/auth/callback',
        state: 'browser-bound-state',
        nonce: 'unused',
        verifier: 'unused',
        clientSecret: 'client-secret',
      }),
    ).rejects.toMatchObject({ code: 'login_denied' });

    const token = fixture({ metadata: { token_endpoint_auth_methods_supported: ['none'] } });
    await token.start();
    await expect(token.exchange()).rejects.toMatchObject({ code: 'oidc_token_failed' });

    const groups = fixture({
      configuration: { requiredGroups: ['employees'] },
      claims: { groups: ['contractors'] },
    });
    await groups.start();
    await expect(groups.exchange()).rejects.toMatchObject({ code: 'oidc_group_not_allowed' });

    const domain = fixture({
      configuration: {
        id: 'google',
        kind: 'google',
        issuer: 'https://accounts.google.com',
        allowedDomains: ['example.com'],
      },
    });
    await domain.start();
    await expect(domain.exchange()).rejects.toMatchObject({ code: 'google_domain_not_allowed' });
  });

  it('rejects issuer confusion and cross-origin metadata endpoints', async () => {
    for (const metadata of [
      { issuer: 'https://other.example.com' },
      { token_endpoint: 'https://other.example.com/token' },
      { jwks_uri: 'https://other.example.com/jwks' },
      { authorization_endpoint: 'https://other.example.com/authorize' },
    ]) {
      const server = fixture({ metadata });
      await expect(server.start()).rejects.toThrow();
      expect(server.request).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects discovery redirects and oversized response bodies', async () => {
    const config = parsePlatformLoginConfiguration({
      id: 'company',
      kind: 'oidc',
      label: 'Company',
      issuer: 'https://identity.example.com',
      clientId: 'client',
    });
    for (const response of [
      new Response(null, { status: 302, headers: { Location: 'https://other.example.com' } }),
      new Response('a'.repeat(256 * 1024 + 1)),
    ]) {
      const request = vi.fn(async () => response);
      await expect(new PlatformOidcProvider(config, request).discover()).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://localhost',
    'https://metadata.internal',
    'https://id.example.com:8080',
    'https://user:password@id.example.com',
    'http://id.example.com',
  ])('rejects private or unsafe endpoint %s', (url) => {
    expect(() => assertPublicIdentityUrl(url)).toThrow();
  });
});
