import { Hono, type Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { pendingAuthenticationSetup } from '../../auth/bootstrap.ts';
import { readAuthSettings, readEnabledLoginConnections } from '../../auth/configuration.ts';
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from '../../auth/github.ts';
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from '../../auth/google.ts';
import { hmacSignState, hmacVerifyState } from '../../auth/hmac.ts';
import { signJwt } from '../../auth/jwt.ts';
import { LoginFailure, loginFailureHint } from '../../auth/login-failure.ts';
import { startPlatformLogin } from '../../auth/login.ts';
import { getPlatformCapabilities } from '../../capabilities.ts';
import {
  bootstrapPlatformAdmin,
  getUserByOAuthAccount,
  getUserByEmail,
  getOAuthAccountIdForUser,
  updateUserProviderId,
  createOAuthAccount,
  storeOAuthNonce,
  consumeOAuthNonce,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { isAdminSuspended } from '../../suspension.ts';
import { adminAccessRejected } from '../middleware/request-rejection.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
type AdminProvider = 'github' | 'google';

function loginFailure(
  context: Context<ApiEnv>,
  message: string,
  status: 400 | 404 | 501,
  details: ReadonlyArray<string> = [],
): Promise<Response> {
  return renderAdminPage(
    context,
    'loginError',
    'Login failed',
    {
      message,
      details,
      platformName: getPlatformDisplayName(context.env, context.req.url),
    },
    { status },
  );
}

export function isAdminOAuthState(state: string): boolean {
  try {
    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1) {
      return false;
    }
    const stateData = JSON.parse(atob(state.slice(0, dotIndex))) as { audience?: unknown };
    return stateData.audience === 'admin';
  } catch {
    return false;
  }
}

app.get('/login', async (context) => {
  if (await pendingAuthenticationSetup(context.get('db'))) {
    return context.redirect('/setup');
  }
  const capabilities = getPlatformCapabilities(context.env);
  const configured = await readAuthSettings(context.get('db'));
  const providers = configured
    ? (await readEnabledLoginConnections(context.get('db'))).map(({ configuration }) => ({
        id: configuration.id,
        label: configuration.label,
      }))
    : [
        ...(capabilities.githubOAuth ? [{ id: 'github', label: 'GitHub' }] : []),
        ...(capabilities.googleOAuth ? [{ id: 'google', label: 'Google' }] : []),
      ];
  return renderAdminPage(context, 'adminLogin', 'Admin Login', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    providers,
  });
});

app.get('/login/:provider', async (context) => {
  const provider = context.req.param('provider');
  const managed = await startPlatformLogin(context, 'admin', provider);
  if (managed) {
    return managed;
  }
  if (provider !== 'github' && provider !== 'google') {
    return loginFailure(context, 'Unknown authentication provider.', 404);
  }
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (provider === 'github' && !capabilities.githubOAuth) ||
    (provider === 'google' && !capabilities.googleOAuth)
  ) {
    return loginFailure(context, 'Authentication provider unavailable.', 501);
  }
  const redirectUri =
    context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).toString();
  const nonce = crypto.randomUUID();
  await storeOAuthNonce(context.get('db'), nonce, 600);
  const stateData = JSON.stringify({ audience: 'admin', nonce, provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;
  const url =
    provider === 'github'
      ? getGitHubAuthorizeUrl(context.env.GITHUB_CLIENT_ID, redirectUri, state)
      : getGoogleAuthorizeUrl(context.env.GOOGLE_CLIENT_ID, redirectUri, state);
  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(context, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: 600,
  });
  return context.redirect(url);
});

export async function handleAdminOAuthCallback(context: Context<ApiEnv>): Promise<Response> {
  const code = context.req.query('code');
  const state = context.req.query('state');

  if (!code || !state) {
    return loginFailure(context, 'Missing code or state.', 400);
  }

  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return loginFailure(context, 'Invalid state.', 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
  if (!valid) {
    return loginFailure(context, 'Invalid state signature.', 400);
  }

  // Consume the nonce atomically — prevents replay of the callback URL
  let nonce: string;
  let provider: AdminProvider;
  try {
    const stateData = JSON.parse(atob(stateEncoded)) as {
      audience?: string;
      nonce: string;
      provider?: AdminProvider;
    };
    if (stateData.audience !== 'admin') {
      throw new Error('unknown audience');
    }
    nonce = stateData.nonce;
    // Preserve Google callbacks initiated before a deployment of this version.
    provider = stateData.provider ?? 'google';
    if (provider !== 'github' && provider !== 'google') {
      throw new Error('unknown provider');
    }
  } catch {
    return loginFailure(context, 'Invalid state data.', 400);
  }

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(context, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return loginFailure(context, 'OAuth session mismatch.', 400);
  }

  const nonceValid = await consumeOAuthNonce(context.get('db'), nonce);
  if (!nonceValid) {
    return loginFailure(context, 'Invalid or expired login state.', 400);
  }

  deleteCookie(context, 'oauth_nonce', { path: '/auth/callback' });

  const redirectUri =
    context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).toString();
  let providerId: string;
  let login: string;
  let email: string | null;
  let emailVerified: boolean;
  if (provider === 'github') {
    let githubUser: Awaited<ReturnType<typeof getGitHubUser>>;
    try {
      const token = await exchangeCodeForToken(
        context.env.GITHUB_CLIENT_ID,
        context.env.GITHUB_CLIENT_SECRET,
        code,
      );
      githubUser = await getGitHubUser(token);
    } catch (error) {
      if (!(error instanceof LoginFailure)) {
        throw error;
      }
      // Log only the failure code, never the provider response.
      console.error('[auth] login failed', { code: error.code, purpose: 'admin', provider });
      const hint = loginFailureHint(error.code);
      return loginFailure(context, hint.message, 400, [
        `Error code: ${error.code}`,
        ...(hint.callback ? [`Callback URL: ${redirectUri}`] : []),
      ]);
    }
    providerId = String(githubUser.id);
    login = githubUser.login;
    email = githubUser.email;
    emailVerified = githubUser.emailVerified;
  } else {
    const token = await exchangeGoogleCode(
      context.env.GOOGLE_CLIENT_ID,
      context.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(token);
    providerId = googleUser.id;
    login = googleUser.email;
    email = googleUser.email;
    emailVerified = googleUser.emailVerified;
  }

  const db = context.get('db');
  let user = await getUserByOAuthAccount(db, provider, providerId);

  // Fall back to email lookup — handles first login after seeding by email
  if (!user && email && emailVerified) {
    const byEmail = await getUserByEmail(db, email);
    // Backfill only an account seeded by email that has never signed in with this
    // provider. Never replace or add to an identity the account already linked.
    if (
      byEmail &&
      byEmail.provider === provider &&
      (await getOAuthAccountIdForUser(db, byEmail.id, provider)) === null
    ) {
      await updateUserProviderId(db, byEmail.id, providerId);
      await createOAuthAccount(db, byEmail.id, provider, providerId);
      user = byEmail;
    }
  }

  if (!user) {
    user = await bootstrapPlatformAdmin(
      db,
      provider,
      providerId,
      login,
      emailVerified ? email : null,
      context.env.PLATFORM_INSTALLATION_ID,
      context.env.PLATFORM_BOOTSTRAP_GITHUB_ID,
    );
  }

  if (!user || user.role !== 'admin') {
    return adminAccessRejected(context, 'required');
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return adminAccessRejected(context, 'suspended');
  }

  const jwt = await signJwt({ sub: user.id, login, aud: 'admin' }, context.env.JWT_SECRET);

  setCookie(context, 'admin_token', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  return context.redirect('/admin/');
}

app.get('/logout', (context) => {
  deleteCookie(context, 'admin_token', { path: '/' });
  return context.redirect('/admin/login');
});

export default app;
