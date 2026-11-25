import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';
import { fetchApi, getApiErrorMessage, readApiJson } from '../../lib/api.ts';
import { isLocalDashboardHost } from '../../lib/origin.ts';

function loginUrl(context: Context): string {
  return `${requestOrigin(context)}/login`;
}

function requestOrigin(context: Context): string {
  const host = context.req.header('host');
  if (!host) {
    return new URL(context.req.url).origin;
  }
  const isLocal = isLocalDashboardHost(host);
  return `${isLocal ? 'http' : 'https'}://${host}`;
}

/** The login page binds the nonce to both a cookie and the callback URL to prevent login CSRF. */
function hasMatchingNonce(context: Context): boolean {
  const nonceCookie = getCookie(context, 'void_auth_nonce');
  const nonceParam = context.req.query('login_nonce');
  if (!nonceCookie || !nonceParam || nonceCookie !== nonceParam) {
    console.warn('[dashboard] auth callback nonce mismatch');
    return false;
  }
  return true;
}

function setSessionCookie(context: Context, token: string, secure: boolean): void {
  deleteCookie(context, 'void_auth_nonce', { path: '/' });
  deleteCookie(context, 'void_auth_nonce', { path: '/auth' });
  setCookie(context, 'void_token', token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
}

export const loader = defineHandler(async (context) => {
  const homeUrl = `${requestOrigin(context)}/`;

  // Exchange the short-lived auth code for a JWT; localhost redeems it with PKCE.
  const code = context.req.query('code');
  if (code) {
    if (!hasMatchingNonce(context)) {
      return context.redirect(loginUrl(context));
    }
    const host = context.req.header('host') ?? '';
    const isLocal = isLocalDashboardHost(host);
    const pkce = getCookie(context, 'void_auth_pkce');
    const separator = pkce?.indexOf(':') ?? -1;
    const pkceState = pkce && separator > 0 ? pkce.slice(0, separator) : undefined;
    const pkceVerifier = pkce && separator > 0 ? pkce.slice(separator + 1) : undefined;
    const callbackState = context.req.query('state');
    if (isLocal && (!pkceState || !pkceVerifier || callbackState !== pkceState)) {
      console.warn('[dashboard] auth callback PKCE state mismatch');
      return context.redirect(loginUrl(context));
    }
    const exchangePath = isLocal ? '/auth/cli/token' : '/auth/exchange';
    let resp: Response;
    try {
      resp = await fetchApi(context, exchangePath, {
        method: 'POST',
        body: JSON.stringify(
          isLocal ? { code, state: pkceState, code_verifier: pkceVerifier } : { code },
        ),
      });
    } catch (error) {
      console.warn(
        `[dashboard] ${exchangePath} request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return context.redirect(loginUrl(context));
    }
    if (!resp.ok) {
      console.warn(
        `[dashboard] ${exchangePath} returned ${resp.status}: ${await getApiErrorMessage(resp)}`,
      );
      return context.redirect(loginUrl(context));
    }
    const exchange = await readApiJson<{ token: string }>(resp);
    if (!exchange?.token) {
      console.warn(`[dashboard] ${exchangePath} returned no token`);
      return context.redirect(loginUrl(context));
    }
    deleteCookie(context, 'void_auth_pkce', { path: '/auth/callback' });
    setSessionCookie(context, exchange.token, !isLocal);
    return context.redirect(homeUrl);
  }

  // Local dev: token arrives as query param (localhost-only, not available in production)
  // Use Host header, not context.req.url — Workers Assets internal dispatch can set
  // context.req.url to localhost even in production.
  const token = context.req.query('token');
  if (token) {
    const host = context.req.header('host') ?? '';
    if (!isLocalDashboardHost(host)) {
      return context.redirect(loginUrl(context));
    }
    if (!hasMatchingNonce(context)) {
      return context.redirect(loginUrl(context));
    }
    setSessionCookie(context, token, false);
    return context.redirect(homeUrl);
  }

  return context.redirect(loginUrl(context));
});
