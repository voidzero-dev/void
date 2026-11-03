import { type PlatformLoginConfiguration, parsePlatformIdentityUrl } from '@void/platform';
import * as oauth from 'oauth4webapi';
import { assertPublicIdentityUrl, boundedIdentityResponse } from './identity-network.ts';
import { LoginFailure } from './login-failure.ts';
export { assertPublicIdentityUrl } from './identity-network.ts';

import type { PlatformOidcIdentity } from './identity-types.ts';
export type { PlatformOidcIdentity } from './identity-types.ts';

type IdentityFetch = (url: string, options: RequestInit) => Promise<Response>;
const GOOGLE_ENDPOINTS = new Set([
  'https://accounts.google.com/o/oauth2/v2/auth',
  'https://oauth2.googleapis.com/token',
  'https://www.googleapis.com/oauth2/v3/certs',
]);

/** One instance per configured issuer/revision; metadata and JWK caches never cross issuers. */
export class PlatformOidcProvider {
  private metadata?: { server: oauth.AuthorizationServer; expiresAt: number };
  private readonly issuer: URL;

  constructor(
    readonly configuration: PlatformLoginConfiguration,
    private readonly request: IdentityFetch = (url, options) => fetch(url, options),
  ) {
    if (configuration.kind === 'github' || !configuration.issuer) {
      throw new Error('An OIDC connection is required.');
    }
    this.issuer = assertPublicIdentityUrl(
      parsePlatformIdentityUrl(configuration.issuer, 'OIDC issuer'),
    );
  }

  private endpoint(input: string): URL {
    const url = assertPublicIdentityUrl(input);
    if (
      url.origin !== this.issuer.origin &&
      !(this.configuration.kind === 'google' && GOOGLE_ENDPOINTS.has(url.href))
    ) {
      throw new Error('Discovered identity endpoints must belong to the configured issuer.');
    }
    return url;
  }

  private readonly network = async (url: string, options: RequestInit): Promise<Response> => {
    this.endpoint(url);
    const signal = AbortSignal.timeout(10_000);
    const response = await this.request(url, { ...options, redirect: 'manual', signal });
    // Never follow redirects with a client secret, authorization code, or other credentials.
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new Error('Identity endpoint redirects are not allowed.');
    }
    return boundedIdentityResponse(response);
  };

  async discover(): Promise<oauth.AuthorizationServer> {
    if (this.metadata && this.metadata.expiresAt > Date.now()) {
      return this.metadata.server;
    }
    const response = await oauth.discoveryRequest(this.issuer, {
      [oauth.customFetch]: this.network,
    });
    const server = await oauth.processDiscoveryResponse(this.issuer, response);
    if (server.issuer !== this.configuration.issuer) {
      throw new Error('The discovered issuer must exactly match the configured issuer.');
    }
    for (const endpoint of [
      server.authorization_endpoint,
      server.token_endpoint,
      server.jwks_uri,
    ]) {
      if (typeof endpoint !== 'string') {
        throw new Error(
          'OIDC discovery must provide authorization, token, and signing-key endpoints.',
        );
      }
      this.endpoint(endpoint);
    }
    if (!server.response_types_supported?.includes('code')) {
      throw new Error('The identity provider must support the authorization-code flow.');
    }
    this.client(server);
    this.metadata = { server, expiresAt: Date.now() + 5 * 60 * 1000 };
    return server;
  }

  /** Discovery for a login flow, where any failure means the issuer setting is wrong or unreachable. */
  private async discoverForLogin(): Promise<oauth.AuthorizationServer> {
    try {
      return await this.discover();
    } catch (error) {
      throw new LoginFailure(
        'oidc_discovery_failed',
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private client(server: oauth.AuthorizationServer): oauth.Client {
    const supported = server.id_token_signing_alg_values_supported ?? ['RS256'];
    const algorithm = ['RS256', 'ES256', 'PS256', 'EdDSA'].find((value) =>
      supported.includes(value),
    );
    if (!algorithm) {
      throw new Error('The identity provider must support asymmetric ID-token signatures.');
    }
    return { client_id: this.configuration.clientId, id_token_signed_response_alg: algorithm };
  }

  async authorize(
    redirectUri: string,
    state: string,
  ): Promise<{ url: string; verifier: string; nonce: string }> {
    const server = await this.discoverForLogin();
    const verifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const url = new URL(server.authorization_endpoint!);
    url.searchParams.set('client_id', this.configuration.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      this.configuration.requiredGroups.length
        ? 'openid email profile groups'
        : 'openid email profile',
    );
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (this.configuration.kind === 'google' && this.configuration.allowedDomains.length === 1) {
      url.searchParams.set('hd', this.configuration.allowedDomains[0]!);
    }
    return { url: url.href, verifier, nonce };
  }

  async exchange(input: {
    callback: URL;
    redirectUri: string;
    state: string;
    verifier: string;
    nonce: string;
    clientSecret: string;
  }): Promise<PlatformOidcIdentity> {
    const server = await this.discoverForLogin();
    const client = this.client(server);
    let claims: oauth.IDToken;
    try {
      const params = oauth.validateAuthResponse(server, client, input.callback, input.state);
      const methods = server.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      // Prefer the form body: Basic credentials are form-encoded first (RFC 6749 §2.3.1), which
      // escapes `-`, `.` and `_`, and providers such as Google compare them without decoding.
      const auth = methods.includes('client_secret_post')
        ? oauth.ClientSecretPost(input.clientSecret)
        : methods.includes('client_secret_basic')
          ? oauth.ClientSecretBasic(input.clientSecret)
          : null;
      if (!auth) {
        throw new Error('The identity provider must support client-secret authentication.');
      }
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        client,
        auth,
        params,
        input.redirectUri,
        input.verifier,
        { [oauth.customFetch]: this.network },
      );
      const tokens = await oauth.processAuthorizationCodeResponse(server, client, response, {
        expectedNonce: input.nonce,
        requireIdToken: true,
      });
      await oauth.validateApplicationLevelSignature(server, response, {
        [oauth.customFetch]: this.network,
      });
      claims = oauth.getValidatedIdTokenClaims(tokens)!;
      if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) {
        throw new Error(
          'The identity provider must return a nonempty subject of at most 255 characters.',
        );
      }
    } catch (error) {
      // One code for the whole token step: the provider's error body is never read.
      throw error instanceof oauth.AuthorizationResponseError && error.error === 'access_denied'
        ? new LoginFailure('login_denied', error.message)
        : new LoginFailure('oidc_token_failed', error instanceof Error ? error.message : undefined);
    }
    const groups =
      Array.isArray(claims.groups) && claims.groups.every((group) => typeof group === 'string')
        ? (claims.groups as Array<string>)
        : [];
    if (
      this.configuration.allowedDomains.length &&
      (typeof claims.hd !== 'string' ||
        !this.configuration.allowedDomains.includes(claims.hd.toLowerCase()))
    ) {
      throw new LoginFailure(
        'google_domain_not_allowed',
        'This Google account does not belong to an allowed Workspace domain.',
      );
    }
    if (
      this.configuration.requiredGroups.length &&
      !this.configuration.requiredGroups.some((group) => groups.includes(group))
    ) {
      throw new LoginFailure(
        'oidc_group_not_allowed',
        'This identity does not belong to an allowed group.',
      );
    }
    const email =
      typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null;
    return {
      issuer: claims.iss,
      subject: claims.sub,
      login:
        typeof claims.preferred_username === 'string' && claims.preferred_username.length <= 320
          ? claims.preferred_username
          : (email ?? claims.sub),
      email,
      emailVerified: email !== null && claims.email_verified === true,
      groups,
    };
  }
}
