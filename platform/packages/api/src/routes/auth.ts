import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { handleAdminOAuthCallback, isAdminOAuthState } from '../admin/routes/login.ts';
import { AuthenticationConfigurationError, readAuthSettings } from '../auth/configuration.ts';
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from '../auth/github.ts';
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from '../auth/google.ts';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import { signJwt, verifyJwt } from '../auth/jwt.ts';
import {
  startPlatformLogin,
  completePlatformLogin,
  startLoginTest,
  createLoginTestLaunch,
  confirmIdentityLink,
} from '../auth/login.ts';
import {
  CLI_CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  isValidCodeVerifier,
} from '../auth/pkce.ts';
import { updateUserRevokingInheritedDestinations } from '../auth/profile.ts';
import {
  isAllowedRedirect,
  isLocalhostRedirect,
  isAuthorizationRedirect,
} from '../auth/redirects.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { acceptsBrowserHtml, platformBrowserError } from '../browser-page.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
export { isAllowedRedirect } from '../auth/redirects.ts';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  createUserForPlatform,
  updateUser,
  createOAuthAccount,
  acceptInvitationByEmail,
  storeOAuthNonce,
  consumeOAuthNonce,
  storeAuthCode,
  consumeAuthCode,
  consumeCliAuthCode,
  linkGitHubInstallationToUser,
  linkGitHubIdentity,
  GitHubIdentityAlreadyLinkedError,
  SelfHostedSignupRestrictedError,
} from '../db.ts';
import { sendWelcomeEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { isDevBypass } from '../env.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { users } from '../schema.ts';
import { isSignupAllowed, getAllowlist } from '../signup-allowlist.ts';

const DEFAULT_REDIRECT_URI = 'https://api.void.cloud/auth/callback';
const DASHBOARD_AUTH_CODE_TTL_SECONDS = 5 * 60;
const CLI_AUTH_CODE_TTL_SECONDS = 5 * 60;

const app = new Hono<ApiEnv>();
app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  await next();
  // Only browser navigation gets a presentation layer; API error bodies stay JSON.
  if (
    ['/auth/login', '/auth/callback', '/auth/link/confirm'].includes(context.req.path) &&
    acceptsBrowserHtml(context) &&
    context.res.status >= 400 &&
    context.res.headers.get('Content-Type')?.includes('application/json')
  ) {
    const body = (await context.res
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    const [title, message] =
      body?.error === 'invalid or expired OAuth state'
        ? ['Your sign-in link expired', 'Start a new sign-in to continue.']
        : body?.error === 'identity_link_required'
          ? [
              'This login is not linked',
              'This email belongs to an existing account. Sign in again with the GitHub or Google account you used before.',
            ]
          : [
              'Login failed',
              'Login could not be completed. Start a new sign-in or contact your platform administrator.',
            ];
    context.res = platformBrowserError(context, title, message, context.res.status as 400);
  }
});
app.get('/test', (context) => startLoginTest(context));
app.get('/link', (context) => startLoginTest(context, 'link'));
app.post('/link/confirm', confirmIdentityLink);
app.post('/link', authMiddleware, async (context) => {
  const session = context.get('humanSession');
  if (!session) {
    return context.json(
      {
        error: 'reauthentication_required',
        message: 'Sign in again before linking another login method.',
      },
      401,
    );
  }
  const body = await context.req.json<{ connectionId?: unknown }>().catch(() => null);
  if (typeof body?.connectionId !== 'string') {
    return context.json({ error: 'connectionId is required' }, 400);
  }
  try {
    const launch = await createLoginTestLaunch(
      context,
      {
        userId: context.get('user').id,
        sessionId: session.id,
        audience: 'api',
        companyIdentity: context.get('companyIdentity'),
      },
      body.connectionId,
      'link',
    );
    return context.json(launch);
  } catch (error) {
    if (error instanceof AuthenticationConfigurationError) {
      return context.json({ error: error.code, message: error.message }, error.status as 400);
    }
    throw error;
  }
});

// GET /auth/login?redirect=http://localhost:PORT/callback&provider=github|google
app.get('/login', async (context) => {
  const managed = await startPlatformLogin(context, 'login');
  if (managed) {
    return managed;
  }
  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }

  if (
    !isAllowedRedirect(
      redirect,
      context.env.DASHBOARD_URL,
      context.env.PLATFORM_INSTALLATION_ID,
      context.env.AUTH_REDIRECT_URI,
    )
  ) {
    return context.json({ error: 'redirect must be a localhost or dashboard URL' }, 400);
  }

  const provider = context.req.query('provider') ?? 'github';
  if (provider !== 'github' && provider !== 'google') {
    return context.json({ error: 'provider must be github or google' }, 400);
  }
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (provider === 'github' && !capabilities.githubOAuth) ||
    (provider === 'google' && !capabilities.googleOAuth)
  ) {
    return context.json({ error: 'authentication provider unavailable', provider }, 501);
  }

  const codeChallenge = context.req.query('code_challenge');
  const codeChallengeMethod = context.req.query('code_challenge_method');
  let cliState: string | null = null;

  if (
    codeChallenge ||
    codeChallengeMethod ||
    isAuthorizationRedirect(redirect, context.env.AUTH_REDIRECT_URI)
  ) {
    const redirectUrl = new URL(redirect);
    cliState = redirectUrl.searchParams.get('state');

    if (
      !isLocalhostRedirect(redirectUrl) &&
      !isAuthorizationRedirect(redirect, context.env.AUTH_REDIRECT_URI)
    ) {
      return context.json({ error: 'CLI code exchange requires a localhost redirect' }, 400);
    }
    if (!cliState) {
      return context.json({ error: 'CLI code exchange requires callback state' }, 400);
    }
    if (!codeChallenge || codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD) {
      return context.json({ error: 'code_challenge_method must be S256' }, 400);
    }
  }

  const nonce = crypto.randomUUID();

  // Store nonce in PostgreSQL so callback can validate it (prevents login CSRF / replay).
  // Not KV: login and callback can hit different CF colos, and KV's eventual consistency
  // would make the lookup flaky. PG also gives us atomic DELETE for true single-use.
  const db = context.get('db');
  await storeOAuthNonce(db, nonce, 600);

  const stateData = JSON.stringify({
    redirect,
    nonce,
    provider,
    cliState,
    codeChallenge,
    codeChallengeMethod,
  });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;

  const redirectUri = context.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(context, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: 600,
  });

  if (provider === 'google') {
    const url = getGoogleAuthorizeUrl(context.env.GOOGLE_CLIENT_ID, redirectUri, state);
    return context.redirect(url);
  }

  const url = getGitHubAuthorizeUrl(context.env.GITHUB_CLIENT_ID, redirectUri, state);
  return context.redirect(url);
});

// GET /auth/dev-login?redirect=http://localhost:PORT/auth/callback — localhost-only, DEV_AUTH_BYPASS only
app.get('/dev-login', async (context) => {
  if (!isDevBypass(context.env)) {
    return context.json({ error: 'not found' }, 404);
  }

  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }

  const user = await context
    .get('db')
    .select()
    .from(users)
    .limit(1)
    .then((rows) => rows[0]);
  if (!user) {
    return context.json({ error: 'no seeded user — run pnpm -C packages/api setup' }, 404);
  }

  const jwt = await signJwt(
    { sub: user.id, login: user.login, aud: 'api' },
    context.env.JWT_SECRET,
  );

  const url = redirectUrl;
  url.searchParams.set('token', jwt);
  // 200 + JS redirect, not 302 — the target is always localhost and `wrangler dev`
  // mangles `Location: http://localhost:*` headers (see html-redirect.ts / meta/lessons.md).
  return localhostRedirectResponse(url.toString(), 'Dev login');
});

// GET /auth/callback?code=...&state=...
app.get('/callback', async (context) => {
  const code = context.req.query('code');
  const state = context.req.query('state');
  if (state?.startsWith('platform.')) {
    return completePlatformLogin(context);
  }

  if (!code || !state) {
    return context.json({ error: 'missing code or state' }, 400);
  }

  if (await readAuthSettings(context.get('db'))) {
    return context.json(
      { error: 'login_changed', message: 'Login settings changed. Start a new login.' },
      409,
    );
  }

  if (isAdminOAuthState(state)) {
    return handleAdminOAuthCallback(context);
  }

  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return context.json({ error: 'invalid state' }, 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
  if (!valid) {
    return context.json({ error: 'invalid state signature' }, 400);
  }

  const { redirect, nonce, provider, cliState, codeChallenge, codeChallengeMethod } = JSON.parse(
    atob(stateEncoded),
  ) as {
    redirect: string;
    nonce: string;
    provider?: string;
    cliState?: string | null;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  };

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(context, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return context.json({ error: 'OAuth session mismatch' }, 400);
  }

  // Validate and consume nonce atomically (single-use, 10-minute TTL).
  // Uses PostgreSQL — not KV — for strong consistency across colos.
  const db = context.get('db');
  const nonceValid = await consumeOAuthNonce(db, nonce);
  if (!nonceValid) {
    return context.json({ error: 'invalid or expired OAuth state' }, 400);
  }

  // Clear the cookie only after successful validation so stale callbacks
  // from duplicate tabs don't invalidate a legitimate in-progress login.
  deleteCookie(context, 'oauth_nonce', { path: '/auth/callback' });

  // Re-validate redirect after decoding
  if (
    !isAllowedRedirect(
      redirect,
      context.env.DASHBOARD_URL,
      context.env.PLATFORM_INSTALLATION_ID,
      context.env.AUTH_REDIRECT_URI,
    )
  ) {
    return context.json({ error: 'invalid redirect' }, 400);
  }

  const resolvedProvider = provider ?? 'github';
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (resolvedProvider === 'github' && !capabilities.githubOAuth) ||
    (resolvedProvider === 'google' && !capabilities.googleOAuth)
  ) {
    return context.json(
      { error: 'authentication provider unavailable', provider: resolvedProvider },
      501,
    );
  }
  let providerId: string;
  let login: string;
  let email: string | null;
  let emailVerified: boolean;

  if (resolvedProvider === 'google') {
    const redirectUri = context.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
    const googleToken = await exchangeGoogleCode(
      context.env.GOOGLE_CLIENT_ID,
      context.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(googleToken);
    providerId = googleUser.id;
    login = googleUser.email;
    email = googleUser.email;
    emailVerified = googleUser.emailVerified;
  } else {
    const ghToken = await exchangeCodeForToken(
      context.env.GITHUB_CLIENT_ID,
      context.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const ghUser = await getGitHubUser(ghToken);
    providerId = String(ghUser.id);
    login = ghUser.login;
    email = ghUser.email;
    emailVerified = ghUser.emailVerified;
  }
  // Set when the email-match branch rejects a SECOND github identity for an account that already has one
  // (RFC 0074). The user is signed into the existing account, but `providerId` is NOT their github identity, so
  // the installation backfill below must be skipped.
  let githubIdentityRejected = false;

  // Upsert user — check oauth_accounts first, then email, then create
  let user = await getUserByOAuthAccount(db, resolvedProvider, providerId);
  if (user) {
    // Only update login/email when the provider matches the user's primary provider
    // (avoids overwriting GitHub username with Google email)
    if (user.provider === resolvedProvider) {
      // Only overwrite stored email when the new one is verified;
      // a transient /user/emails failure must not wipe the existing email.
      if (emailVerified) {
        await updateUserRevokingInheritedDestinations(db, user.id, login, user.email, email);
      } else {
        await updateUser(db, user.id, login, user.email);
      }
    }
  } else if (email && emailVerified) {
    // Link new provider to existing account with the same email.
    const existing = await getUserByEmail(db, email);
    if (existing) {
      if (existing.role === 'admin') {
        // An administrator's login token can open an operator session, so a matching
        // email alone must not sign in to or link an administrator account.
        // Administrators sign in with a login already linked to them. Managed login
        // refuses email links for every account.
        return context.json(
          {
            error: 'identity_link_required',
            message: 'Sign in again with the GitHub or Google account you used before.',
          },
          409,
        );
      }
      if (resolvedProvider === 'github') {
        // Enforce RFC 0074's one-github-identity-per-account invariant on the login
        // path too (Vercel model: a Void account has a single GitHub login identity;
        // extra repo access is via installations, not a second identity). `providerId`
        // is guaranteed NOT yet an oauth row (the getUserByOAuthAccount branch above
        // handled that), so linkGitHubIdentity either links it (existing had no github)
        // or throws GitHubIdentityAlreadyLinkedError (existing already linked a
        // DIFFERENT github) — in which case sign the user into the existing account
        // WITHOUT creating a duplicate github row.
        try {
          await linkGitHubIdentity(db, existing.id, providerId);
        } catch (err) {
          if (!(err instanceof GitHubIdentityAlreadyLinkedError)) {
            throw err;
          }
          githubIdentityRejected = true;
        }
      } else {
        await createOAuthAccount(db, existing.id, resolvedProvider, providerId);
      }
      user = existing;
    }
  }

  let createdUser = false;
  if (!user) {
    // Check signup allowlist (new users only)
    const enabled = await context.env.ROUTING.get('signup:enabled');
    const selfHosted = Boolean(context.env.PLATFORM_INSTALLATION_ID);
    let additionalSignupAllowed = !selfHosted || enabled === 'false';
    if (enabled === 'true' || (selfHosted && enabled !== 'false')) {
      const entries = await getAllowlist(context.env.ROUTING);
      additionalSignupAllowed = isSignupAllowed(
        resolvedProvider,
        login,
        emailVerified ? email : null,
        entries,
      );
      if (!selfHosted && !additionalSignupAllowed) {
        return context.redirect('/signup-restricted');
      }
    }
    try {
      user = await db.transaction(async (tx) => {
        const newUser = await createUserForPlatform(
          tx,
          resolvedProvider,
          providerId,
          login,
          emailVerified ? email : null,
          context.env.PLATFORM_INSTALLATION_ID,
          {
            additionalSignupAllowed,
            bootstrapGitHubId: context.env.PLATFORM_BOOTSTRAP_GITHUB_ID ?? '',
          },
        );
        await createOAuthAccount(tx, newUser.id, resolvedProvider, providerId);
        return newUser;
      });
    } catch (error) {
      if (error instanceof SelfHostedSignupRestrictedError) {
        return context.redirect('/signup-restricted');
      }
      throw error;
    }
    createdUser = true;
  }

  if (emailVerified && email) {
    try {
      await acceptInvitationByEmail(db, email, user.id);
    } catch (err) {
      console.error(`Failed to accept invitation for ${email} (user ${user.id}):`, err);
    }
    if (createdUser && context.env.EMAIL) {
      context.executionCtx.waitUntil(
        sendWelcomeEmail(context.env, email, login).catch((err: unknown) =>
          console.error(`[welcome-email] Failed for ${email}:`, err),
        ),
      );
    }
  }

  if (resolvedProvider === 'github' && !githubIdentityRejected) {
    // Backfill GitHub App installations created before this user signed in.
    // `providerId` is the user's numeric GitHub account id, matched against
    // `github_installations.account_id`. Best-effort — a failure here must
    // never block login.
    try {
      await linkGitHubInstallationToUser(db, providerId, user.id);
    } catch (err) {
      console.error(`[github-app] Failed to backfill installations for ${login}:`, err);
    }
  }

  const jwt = await signJwt({ sub: user.id, login, aud: 'api' }, context.env.JWT_SECRET);

  const redirectUrl = new URL(redirect);

  if (
    isLocalhostRedirect(redirectUrl) ||
    isAuthorizationRedirect(redirect, context.env.AUTH_REDIRECT_URI)
  ) {
    if (codeChallenge && codeChallengeMethod === CLI_CODE_CHALLENGE_METHOD && cliState) {
      const authCode = crypto.randomUUID();
      await storeAuthCode(db, authCode, jwt, CLI_AUTH_CODE_TTL_SECONDS, {
        cliState,
        codeChallenge,
        codeChallengeMethod,
      });
      redirectUrl.searchParams.set('code', authCode);
      redirectUrl.searchParams.delete('token');
    } else {
      // Legacy CLI / local dev: token in query param (localhost-only, safe).
      redirectUrl.searchParams.set('token', jwt);
    }
  } else {
    // Dashboard: short-lived auth code exchanged server-side, so the JWT never appears in the URL.
    // Stored in PostgreSQL (not KV) for strong cross-colo consistency and atomic single-use
    // via DELETE … RETURNING — same rationale as the OAuth nonce flow.
    const authCode = crypto.randomUUID();
    await storeAuthCode(db, authCode, jwt, DASHBOARD_AUTH_CODE_TTL_SECONDS);
    redirectUrl.searchParams.set('code', authCode);
  }

  return context.redirect(redirectUrl.toString());
});

// POST /auth/exchange — single-use code → JWT (called by dashboard callback)
app.post('/exchange', async (context) => {
  const { code } = await context.req.json<{ code: string }>();
  if (!code) {
    return context.json({ error: 'missing code' }, 400);
  }

  const db = context.get('db');
  const jwt = await consumeAuthCode(db, code);
  const payload = jwt ? await verifyJwt(jwt, context.env.JWT_SECRET, 'api') : null;
  if (!payload || !(await validateHumanSession(db, payload, context.get('companyIdentity')))) {
    return context.json({ error: 'invalid or expired code' }, 400);
  }

  return context.json({ token: jwt });
});

// POST /auth/cli/token — single-use CLI code + PKCE verifier → JWT
app.post('/cli/token', async (context) => {
  const body = await context.req.json<{
    code?: unknown;
    state?: unknown;
    code_verifier?: unknown;
  }>();

  if (
    typeof body.code !== 'string' ||
    typeof body.state !== 'string' ||
    !isValidCodeVerifier(body.code_verifier)
  ) {
    return context.json({ error: 'code, state, and code_verifier are required' }, 400);
  }

  const codeChallenge = await createCodeChallenge(body.code_verifier);
  const db = context.get('db');
  const jwt = await consumeCliAuthCode(
    db,
    body.code,
    body.state,
    codeChallenge,
    CLI_CODE_CHALLENGE_METHOD,
  );

  const payload = jwt ? await verifyJwt(jwt, context.env.JWT_SECRET, 'api') : null;
  if (!payload || !(await validateHumanSession(db, payload, context.get('companyIdentity')))) {
    return context.json({ error: 'invalid or expired code' }, 400);
  }

  return context.json({ token: jwt });
});

export default app;
