import type { PlatformLoginConfiguration, PlatformAuthenticationRecovery } from '@void/platform';
import {
  browserPageIdentity,
  browserPageLead,
  browserPageStatus,
} from '@void/platform/browser-page';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { acceptsBrowserHtml, platformBrowserError, platformBrowserPage } from '../browser-page.ts';
import { acceptInvitationByEmail, linkGitHubInstallationToUser, storeAuthCode } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { platformAuthAttempts, platformLoginTests } from '../schema.ts';
import { stageBootstrapIdentity, verifyBootstrapCode } from './bootstrap.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  readAuthSettings,
  readLoginConnection,
  readLoginRevision,
  readLoginSecret,
} from './configuration.ts';
import { exchangeCodeForToken, getGitHubAuthorizeUrl, getGitHubUser } from './github.ts';
import { resolvePlatformLogin } from './identities.ts';
import { verifyJwt } from './jwt.ts';
import { LoginFailure, loginFailureHint } from './login-failure.ts';
import { linkTestedIdentity, requireRecentAuthentication } from './management.ts';
import type { AuthenticationActor } from './management.ts';
import { PlatformOidcProvider } from './oidc.ts';
import type { PlatformOidcIdentity } from './oidc.ts';
import { createCodeChallenge } from './pkce.ts';
import { hashLoginProof, randomLoginProof } from './proofs.ts';
import { validateRecoveryTest } from './recovery.ts';
import { isAllowedRedirect, isLocalhostRedirect, isAuthorizationRedirect } from './redirects.ts';
import { createHumanSession, validateHumanSession } from './sessions.ts';
import type { CompanyIdentity } from './sessions.ts';

const COOKIE = 'void_platform_auth';
const FLOW_SECONDS = 600;
const providers = new Map<string, PlatformOidcProvider>();

type LoginContext = {
  redirect: string;
  redirectUri: string;
  verifier: string;
  nonce?: string;
  cliState?: string;
  codeChallenge?: string;
  companyIdentity?: CompanyIdentity;
  actor?: AuthenticationActor;
  testId?: string;
  bootstrapCredentialHash?: string;
  bootstrapInstallationId?: string;
  recovery?: PlatformAuthenticationRecovery;
};

function oidcProvider(configuration: PlatformLoginConfiguration): PlatformOidcProvider {
  const key = JSON.stringify(configuration);
  let provider = providers.get(key);
  if (!provider) {
    if (providers.size >= 32) {
      providers.delete(providers.keys().next().value!);
    }
    provider = new PlatformOidcProvider(configuration);
    providers.set(key, provider);
  }
  return provider;
}

/** What is known about the login attempt when it failed. */
type LoginAttemptDetails = { purpose?: string; connectionId?: string; redirectUri?: string };

function authenticationError(
  context: Context<ApiEnv>,
  error: unknown,
  attempt: LoginAttemptDetails = {},
): Response {
  // Provider responses may contain secrets or untrusted data. Log only the
  // failure code, never provider bodies, tokens, or error messages.
  const code =
    error instanceof AuthenticationConfigurationError || error instanceof LoginFailure
      ? error.code
      : 'unexpected';
  console.error('[auth] login failed', {
    code,
    ...(code === 'unexpected' && error instanceof Error ? { name: error.name } : {}),
    ...(attempt.purpose ? { purpose: attempt.purpose } : {}),
    ...(attempt.connectionId ? { connectionId: attempt.connectionId } : {}),
  });
  if (error instanceof LoginFailure) {
    const hint = loginFailureHint(error.code);
    if (!acceptsBrowserHtml(context)) {
      return context.json({ error: 'login_failed', code: error.code, message: hint.message }, 400);
    }
    const bootstrap = attempt.purpose === 'bootstrap';
    const groups = error.code === 'oidc_group_not_allowed';
    return platformBrowserError(context, 'Login failed', hint.message, 400, {
      details: [
        `Error code: ${error.code}`,
        ...(hint.callback
          ? [
              `Callback URL: ${attempt.redirectUri ?? context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href}`,
            ]
          : []),
        ...(bootstrap
          ? [
              groups
                ? 'To change the allowed groups, run this on the computer that installed the platform, with an authentication file:'
                : 'To change the login settings, run this on the computer that installed the platform:',
            ]
          : []),
      ],
      ...(bootstrap
        ? {
            command: `void platform repair ${context.env.PLATFORM_INSTALLATION_ID ?? '<id>'}${groups ? ' --auth-config <path>' : ''}`,
            returnUrl: '/setup',
          }
        : {}),
    });
  }
  if (error instanceof AuthenticationConfigurationError) {
    if (acceptsBrowserHtml(context)) {
      return platformBrowserError(
        context,
        'Login failed',
        error.message,
        error.status as ContentfulStatusCode,
      );
    }
    return context.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  if (acceptsBrowserHtml(context)) {
    return platformBrowserError(
      context,
      'Login failed',
      'Login could not be completed. Start a new login or check the provider configuration.',
      400,
    );
  }
  return context.json(
    {
      error: 'login_failed',
      message:
        'Login could not be completed. Start a new login or check the provider configuration.',
    },
    400,
  );
}

async function preserveLegacyLoginEffects(
  db: Db,
  input: {
    connectionKind: PlatformLoginConfiguration['kind'];
    userId: string;
    identity: PlatformOidcIdentity;
  },
): Promise<void> {
  if (input.identity.emailVerified && input.identity.email) {
    try {
      await acceptInvitationByEmail(db, input.identity.email, input.userId);
    } catch (error) {
      console.error(
        `Failed to accept invitation for ${input.identity.email} (user ${input.userId}):`,
        error,
      );
    }
  }
  if (input.connectionKind === 'github') {
    try {
      await linkGitHubInstallationToUser(db, input.identity.subject, input.userId);
    } catch (error) {
      console.error(
        `[github-app] Failed to backfill installations for ${input.identity.login}:`,
        error,
      );
    }
  }
}

async function authorizationFor(
  configuration: PlatformLoginConfiguration,
  redirectUri: string,
  state: string,
): Promise<{ url: string; verifier: string; nonce?: string }> {
  if (configuration.kind !== 'github') {
    return oidcProvider(configuration).authorize(redirectUri, state);
  }
  const verifier = randomLoginProof();
  const url = new URL(getGitHubAuthorizeUrl(configuration.clientId, redirectUri, state));
  url.searchParams.set('code_challenge', await createCodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.href, verifier };
}

function bindBrowser(context: Context<ApiEnv>, proof: string): void {
  setCookie(context, COOKIE, proof, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: FLOW_SECONDS,
  });
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
}

/** A launch grants only a test, whose identity must be separately confirmed before linking/enabling. */
export async function createLoginTestLaunch(
  context: Context<ApiEnv>,
  actor: AuthenticationActor,
  connectionId: string,
  purpose: 'test' | 'link' = 'test',
): Promise<{ id: string; url: string; expiresAt: string }> {
  const db = context.get('db');
  const connection = await readLoginConnection(db, connectionId);
  if (
    !connection ||
    !(await validateHumanSession(
      db,
      { sub: actor.userId, aud: actor.audience, sid: actor.sessionId },
      actor.companyIdentity,
    ))
  ) {
    throw new AuthenticationConfigurationError(
      'Sign in again before testing a login method.',
      'reauthentication_required',
      401,
    );
  }
  if (purpose === 'link') {
    await requireRecentAuthentication(db, actor);
    if (!connection.enabled || !connection.active_revision) {
      throw new AuthenticationConfigurationError(
        'This login method is unavailable.',
        'provider_unavailable',
        404,
      );
    }
  }
  const id = purpose + '.' + crypto.randomUUID();
  const proof = randomLoginProof();
  const expiresAt = new Date(Date.now() + FLOW_SECONDS * 1000).toISOString();
  await db.insert(platformAuthAttempts).values({
    id,
    connection_id: connectionId,
    revision: purpose === 'link' ? connection.active_revision! : connection.revision,
    generation: connection.generation,
    purpose,
    browser_hash: await hashLoginProof(proof),
    context: { phase: 'launch', actor, companyIdentity: actor.companyIdentity },
    expires_at: expiresAt,
  });
  const url = new URL(
    purpose === 'link' ? '/auth/link' : '/auth/test',
    context.env.AUTH_REDIRECT_URI ?? context.req.url,
  );
  url.searchParams.set('id', id);
  url.searchParams.set('proof', proof);
  return { id, url: url.href, expiresAt };
}

export async function startLoginTest(
  context: Context<ApiEnv>,
  purpose: 'test' | 'link' = 'test',
): Promise<Response> {
  try {
    const db = context.get('db');
    const id = context.req.query('id');
    const proof = context.req.query('proof');
    if (!id || !proof) {
      throw new Error('Missing test launch');
    }
    const [launch] = await db
      .delete(platformAuthAttempts)
      .where(
        and(
          eq(platformAuthAttempts.id, id),
          eq(platformAuthAttempts.purpose, purpose),
          eq(platformAuthAttempts.browser_hash, await hashLoginProof(proof)),
          gt(platformAuthAttempts.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    const saved = launch?.context as
      | { phase?: string; actor?: AuthenticationActor; recovery?: PlatformAuthenticationRecovery }
      | undefined;
    const actor = saved?.actor;
    if (purpose === 'link') {
      const browserToken = getCookie(context, 'void_account_session');
      const browserSession = browserToken
        ? await verifyJwt(browserToken, context.env.JWT_SECRET, 'api')
        : null;
      if (
        !browserSession ||
        browserSession.sub !== actor?.userId ||
        browserSession.sid !== actor.sessionId
      ) {
        throw new AuthenticationConfigurationError(
          'Sign in to your existing account in this browser before linking a login method.',
          'reauthentication_required',
          401,
        );
      }
    }
    if (
      !launch ||
      saved?.phase !== 'launch' ||
      !actor ||
      !(saved.recovery
        ? purpose === 'test' &&
          (await validateRecoveryTest(
            db,
            context.env,
            saved.recovery,
            launch,
            launch.id,
            actor.userId,
          ))
        : await validateHumanSession(
            db,
            {
              sub: actor.userId,
              sid: actor.sessionId,
              aud: actor.audience,
            },
            context.get('companyIdentity'),
          ))
    ) {
      throw new Error('Invalid test launch');
    }
    const connection = await readLoginConnection(db, launch.connection_id);
    if (
      !connection ||
      (purpose === 'link'
        ? !connection.enabled || connection.active_revision !== launch.revision
        : connection.revision !== launch.revision) ||
      connection.generation !== launch.generation
    ) {
      throw new Error('Configuration changed');
    }
    if (purpose === 'link') {
      await requireRecentAuthentication(db, {
        ...actor,
        companyIdentity: context.get('companyIdentity'),
      });
    }
    const revision = await readLoginRevision(db, connection.id, launch.revision);
    if (!revision) {
      throw new Error('Configuration missing');
    }
    const redirectUri =
      context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href;
    const state = `platform.${crypto.randomUUID()}`;
    const browserProof = randomLoginProof();
    const authorization = await authorizationFor(revision.configuration, redirectUri, state);
    await db.insert(platformAuthAttempts).values({
      id: state,
      connection_id: connection.id,
      revision: launch.revision,
      generation: launch.generation,
      purpose,
      browser_hash: await hashLoginProof(browserProof),
      context: {
        redirect: '',
        redirectUri,
        verifier: authorization.verifier,
        nonce: authorization.nonce,
        actor,
        recovery: saved.recovery,
        testId: launch.id,
        companyIdentity: context.get('companyIdentity'),
      },
      expires_at: launch.expires_at,
    });
    bindBrowser(context, browserProof);
    return context.redirect(authorization.url);
  } catch (error) {
    return authenticationError(context, error);
  }
}

/** Null means this installation still uses its existing deployment-time login configuration. */
export async function startPlatformLogin(
  context: Context<ApiEnv>,
  purpose: 'login' | 'admin',
  providerId?: string,
): Promise<Response | null> {
  const db = context.get('db');
  if (!(await readAuthSettings(db))) {
    if (context.env.PLATFORM_AUTH_SETUP_TOKEN) {
      return context.json(
        { error: 'setup_pending', message: 'Finish platform administrator setup first.' },
        503,
      );
    }
    return null;
  }
  try {
    const id = providerId ?? context.req.query('provider') ?? 'github';
    const connection = await readLoginConnection(db, id);
    if (!connection?.enabled || !connection.active_revision) {
      throw new AuthenticationConfigurationError(
        'This login method is unavailable.',
        'provider_unavailable',
        404,
      );
    }
    const revision = await readLoginRevision(db, id, connection.active_revision);
    if (!revision) {
      throw new Error('Missing active configuration');
    }
    const redirect = purpose === 'admin' ? '/admin/' : context.req.query('redirect');
    if (
      !redirect ||
      (purpose === 'login' &&
        !isAllowedRedirect(
          redirect,
          context.env.DASHBOARD_URL,
          context.env.PLATFORM_INSTALLATION_ID,
          context.env.AUTH_REDIRECT_URI,
        ))
    ) {
      throw new AuthenticationConfigurationError(
        'A localhost or dashboard redirect is required.',
        'invalid_redirect',
        400,
      );
    }
    const redirectUri =
      context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href;
    const state = `platform.${crypto.randomUUID()}`;
    const browserProof = randomLoginProof();
    const saved: LoginContext = {
      redirect,
      redirectUri,
      verifier: '',
      companyIdentity: context.get('companyIdentity'),
    };
    if (
      purpose === 'login' &&
      (isLocalhostRedirect(new URL(redirect)) ||
        isAuthorizationRedirect(redirect, context.env.AUTH_REDIRECT_URI))
    ) {
      const cliState = new URL(redirect).searchParams.get('state');
      const challenge = context.req.query('code_challenge');
      if (
        !cliState ||
        !challenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        context.req.query('code_challenge_method') !== 'S256'
      ) {
        throw new AuthenticationConfigurationError(
          'CLI login requires PKCE. Update the Void CLI and try again.',
          'pkce_required',
          400,
        );
      }
      saved.cliState = cliState;
      saved.codeChallenge = challenge;
    }
    const authorization = await authorizationFor(revision.configuration, redirectUri, state);
    saved.verifier = authorization.verifier;
    saved.nonce = authorization.nonce;
    await db.insert(platformAuthAttempts).values({
      id: state,
      connection_id: id,
      revision: connection.active_revision,
      generation: connection.generation,
      purpose,
      browser_hash: await hashLoginProof(browserProof),
      context: saved,
      expires_at: new Date(Date.now() + FLOW_SECONDS * 1000).toISOString(),
    });
    bindBrowser(context, browserProof);
    return context.redirect(authorization.url);
  } catch (error) {
    return authenticationError(context, error);
  }
}

export async function completePlatformLogin(context: Context<ApiEnv>): Promise<Response> {
  const db = context.get('db');
  let details: LoginAttemptDetails = {};
  try {
    const state = context.req.query('state');
    const browserProof = getCookie(context, COOKIE);
    if (!state || !browserProof) {
      throw new AuthenticationConfigurationError(
        'The login browser session is missing.',
        'invalid_state',
        400,
      );
    }
    const [attempt] = await db
      .delete(platformAuthAttempts)
      .where(
        and(
          eq(platformAuthAttempts.id, state),
          eq(platformAuthAttempts.browser_hash, await hashLoginProof(browserProof)),
          gt(platformAuthAttempts.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    if (
      !attempt ||
      (attempt.purpose !== 'login' &&
        attempt.purpose !== 'admin' &&
        attempt.purpose !== 'test' &&
        attempt.purpose !== 'link' &&
        attempt.purpose !== 'bootstrap')
    ) {
      throw new AuthenticationConfigurationError(
        'The login attempt expired or was already used.',
        'invalid_state',
        400,
      );
    }
    deleteCookie(context, COOKIE, { path: '/auth/callback' });
    const saved = attempt.context as LoginContext;
    details = {
      purpose: attempt.purpose,
      connectionId: attempt.connection_id,
      redirectUri: saved.redirectUri,
    };
    const currentCompany = context.get('companyIdentity');
    if (
      saved.companyIdentity?.issuer !== currentCompany?.issuer ||
      saved.companyIdentity?.subject !== currentCompany?.subject
    ) {
      throw new AuthenticationConfigurationError(
        'The company identity changed during login.',
        'company_identity_changed',
        403,
      );
    }
    const connection = await readLoginConnection(db, attempt.connection_id);
    if (
      !connection ||
      (attempt.purpose !== 'test' && attempt.purpose !== 'bootstrap' && !connection.enabled) ||
      (attempt.purpose === 'test' || attempt.purpose === 'bootstrap'
        ? connection.revision
        : connection.active_revision) !== attempt.revision ||
      connection.generation !== attempt.generation
    ) {
      throw new AuthenticationConfigurationError(
        'The login method changed. Start a new login.',
        'login_changed',
        401,
      );
    }
    const revision = await readLoginRevision(db, connection.id, attempt.revision);
    if (!revision) {
      throw new Error('Missing login configuration');
    }
    const secret = await readLoginSecret(context.env, revision).catch(() => {
      throw new LoginFailure('login_secret_unreadable');
    });
    let identity: PlatformOidcIdentity;
    if (connection.kind === 'github') {
      const code = context.req.query('code');
      const providerError = context.req.query('error');
      if (!code || providerError) {
        throw new LoginFailure(
          providerError === 'access_denied'
            ? 'login_denied'
            : providerError === 'redirect_uri_mismatch'
              ? 'github_redirect_uri_mismatch'
              : 'github_failed',
          'GitHub login failed',
        );
      }
      const token = await exchangeCodeForToken(
        revision.configuration.clientId,
        secret,
        code,
        saved.redirectUri,
        saved.verifier,
      );
      const user = await getGitHubUser(token);
      identity = {
        issuer: 'https://github.com',
        subject: String(user.id),
        login: user.login,
        email: user.email,
        emailVerified: user.emailVerified,
        groups: [],
      };
    } else {
      if (!saved.nonce) {
        throw new Error('Missing OIDC nonce');
      }
      identity = await oidcProvider(revision.configuration).exchange({
        callback: new URL(context.req.url),
        redirectUri: saved.redirectUri,
        state,
        verifier: saved.verifier,
        nonce: saved.nonce,
        clientSecret: secret,
      });
    }
    if (attempt.purpose === 'bootstrap') {
      if (!saved.bootstrapCredentialHash || !saved.bootstrapInstallationId) {
        throw new Error('Missing setup authority');
      }
      const proof = await stageBootstrapIdentity(db, {
        installationId: saved.bootstrapInstallationId,
        credentialHash: saved.bootstrapCredentialHash,
        connectionId: connection.id,
        revision: attempt.revision,
        generation: attempt.generation,
        identity,
        companyIdentity: currentCompany,
      });
      setCookie(context, 'void_bootstrap_confirm', proof, {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/auth/bootstrap/confirm',
        maxAge: 300,
      });
      context.header('Cache-Control', 'no-store');
      // This page submits an origin-checked confirmation form. Keep the origin
      // while withholding the OAuth callback path and query from referrers.
      context.header('Referrer-Policy', 'strict-origin');
      return platformBrowserPage(
        context,
        'Confirm platform administrator',
        browserPageLead(
          'Confirm the first administrator',
          'Review the account below before giving it administrator access to this platform.',
        ) +
          browserPageIdentity(identity) +
          '<p class="void-auth-note">This account will be able to manage the platform and its users.</p>' +
          '<form method="post" action="/auth/bootstrap/confirm"><input type="hidden" name="confirm" value="yes"><button class="void-auth-button void-auth-button-primary" type="submit">Make this account the platform administrator</button></form>',
      );
    }
    if (attempt.purpose === 'test' || attempt.purpose === 'link') {
      await db.transaction(async (transaction) => {
        await lockAuthSettings(transaction);
        const latest = await readLoginConnection(transaction, connection.id);
        const actor = saved.actor;
        if (
          !actor ||
          !saved.testId ||
          !latest ||
          (attempt.purpose === 'link'
            ? !latest.enabled || latest.active_revision !== attempt.revision
            : latest.revision !== attempt.revision) ||
          latest.generation !== attempt.generation ||
          !(saved.recovery
            ? attempt.purpose === 'test' &&
              (await validateRecoveryTest(
                transaction,
                context.env,
                saved.recovery,
                attempt,
                saved.testId,
                actor.userId,
              ))
            : await validateHumanSession(
                transaction,
                { sub: actor.userId, sid: actor.sessionId, aud: actor.audience },
                currentCompany,
              ))
        ) {
          throw new AuthenticationConfigurationError(
            'The test or administrator session changed. Start a new test.',
            'login_changed',
            401,
          );
        }
        if (attempt.purpose === 'link') {
          await requireRecentAuthentication(transaction, {
            ...actor,
            companyIdentity: currentCompany,
          });
        }
        await transaction.insert(platformLoginTests).values({
          id: saved.testId,
          user_id: actor.userId,
          connection_id: connection.id,
          revision: attempt.revision,
          issuer: identity.issuer,
          subject: identity.subject,
          login: identity.login,
          expires_at: new Date(Date.now() + FLOW_SECONDS * 1000).toISOString(),
        });
      });
      context.header('Cache-Control', 'no-store');
      context.header('Referrer-Policy', 'no-referrer');
      if (attempt.purpose === 'link') {
        // Native confirmation needs its same-origin Origin header; retain only
        // the origin so OAuth callback codes and state stay out of referrers.
        context.header('Referrer-Policy', 'strict-origin');
        const proof = randomLoginProof();
        await db.insert(platformAuthAttempts).values({
          id: saved.testId!,
          connection_id: connection.id,
          revision: attempt.revision,
          generation: attempt.generation,
          purpose: 'link',
          browser_hash: await hashLoginProof(proof),
          context: { phase: 'confirm', actor: saved.actor },
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
        setCookie(context, 'void_link_confirm', saved.testId + ':' + proof, {
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
          path: '/auth/link/confirm',
          maxAge: 300,
        });
        return platformBrowserPage(
          context,
          'Link login method',
          browserPageLead(
            'Link this login method?',
            'Review the identity before linking it to your existing Void account.',
          ) +
            browserPageIdentity(identity) +
            '<form method="post" action="/auth/link/confirm"><input type="hidden" name="confirm" value="yes"><button class="void-auth-button void-auth-button-primary" type="submit">Link this identity</button></form>',
        );
      }
      if (saved.actor?.audience === 'admin') {
        return context.redirect(`/admin/config/auth?test=${encodeURIComponent(saved.testId!)}`);
      }
      return platformBrowserPage(
        context,
        'Login verified',
        browserPageStatus('success') +
          browserPageLead(
            'Login verified',
            'Return to Void to review the identity and finish configuration.',
          ),
      );
    }
    const { user } = await resolvePlatformLogin(
      db,
      context.env,
      { connectionId: connection.id, revision: attempt.revision, generation: attempt.generation },
      identity,
      currentCompany,
    );
    const audience = attempt.purpose === 'admin' ? 'admin' : 'api';
    const { token, session } = await createHumanSession(db, context.env.JWT_SECRET, {
      userId: user.id,
      connectionId: connection.id,
      revision: attempt.revision,
      generation: attempt.generation,
      audience,
      companyIdentity: currentCompany,
    });
    await preserveLegacyLoginEffects(db, {
      connectionKind: connection.kind,
      userId: user.id,
      identity,
    });
    context.header('Cache-Control', 'no-store');
    if (audience === 'admin') {
      setCookie(context, 'admin_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000)),
      });
      return context.redirect('/admin/');
    }
    // Bind ordinary account-link launches to the browser that just proved the existing
    // account. A copied launch URL must never let another browser attach its identity.
    setCookie(context, 'void_account_session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/auth/link',
      maxAge: FLOW_SECONDS,
    });
    if (
      !isAllowedRedirect(
        saved.redirect,
        context.env.DASHBOARD_URL,
        context.env.PLATFORM_INSTALLATION_ID,
        context.env.AUTH_REDIRECT_URI,
      )
    ) {
      throw new Error('Login redirect no longer allowed');
    }
    const redirect = new URL(saved.redirect);
    const code = crypto.randomUUID();
    if (
      isLocalhostRedirect(redirect) ||
      isAuthorizationRedirect(redirect.href, context.env.AUTH_REDIRECT_URI)
    ) {
      if (!saved.codeChallenge || !saved.cliState) {
        throw new Error('Missing CLI proof');
      }
      await storeAuthCode(db, code, token, 300, {
        cliState: saved.cliState,
        codeChallenge: saved.codeChallenge,
        codeChallengeMethod: 'S256',
      });
    } else {
      await storeAuthCode(db, code, token, 300);
    }
    redirect.searchParams.delete('token');
    redirect.searchParams.set('code', code);
    return context.redirect(redirect.href);
  } catch (error) {
    return authenticationError(context, error, details);
  }
}

export async function startBootstrapLogin(
  context: Context<ApiEnv>,
  code: string,
): Promise<Response> {
  try {
    const db = context.get('db');
    const pending = await verifyBootstrapCode(db, context.env.PLATFORM_INSTALLATION_ID, code);
    const connection = await readLoginConnection(db, pending.connection_id);
    const revision = connection
      ? await readLoginRevision(db, connection.id, connection.revision)
      : null;
    if (!connection || !revision) {
      throw new Error('Setup configuration is unavailable');
    }
    const redirectUri =
      context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href;
    const state = 'platform.' + crypto.randomUUID();
    const browserProof = randomLoginProof();
    const authorization = await authorizationFor(revision.configuration, redirectUri, state);
    await db.insert(platformAuthAttempts).values({
      id: state,
      connection_id: connection.id,
      revision: connection.revision,
      generation: connection.generation,
      purpose: 'bootstrap',
      browser_hash: await hashLoginProof(browserProof),
      expires_at: new Date(
        Math.min(Date.parse(pending.expires_at), Date.now() + FLOW_SECONDS * 1000),
      ).toISOString(),
      context: {
        redirect: '/admin/',
        redirectUri,
        verifier: authorization.verifier,
        nonce: authorization.nonce,
        bootstrapCredentialHash: pending.credential_hash,
        bootstrapInstallationId: pending.installation_id,
        companyIdentity: context.get('companyIdentity'),
      },
    });
    bindBrowser(context, browserProof);
    return context.redirect(authorization.url);
  } catch (error) {
    return authenticationError(context, error, { purpose: 'bootstrap' });
  }
}

/** Browser-bound confirmation; the original user's still-active session owns the new identity. */
export async function confirmIdentityLink(context: Context<ApiEnv>): Promise<Response> {
  try {
    const origin = context.req.header('Origin');
    if (
      origin !== new URL(context.req.url).origin ||
      (await context.req.parseBody()).confirm !== 'yes'
    ) {
      throw new Error('Confirmation required');
    }
    const [id, proof] = (getCookie(context, 'void_link_confirm') ?? '').split(':');
    if (!id || !proof) {
      throw new Error('Confirmation expired');
    }
    const db = context.get('db');
    const [attempt] = await db
      .delete(platformAuthAttempts)
      .where(
        and(
          eq(platformAuthAttempts.id, id),
          eq(platformAuthAttempts.purpose, 'link'),
          eq(platformAuthAttempts.browser_hash, await hashLoginProof(proof)),
          gt(platformAuthAttempts.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    const saved = attempt?.context as { phase?: string; actor?: AuthenticationActor } | undefined;
    if (!attempt || saved?.phase !== 'confirm' || !saved.actor) {
      throw new Error('Confirmation expired');
    }
    const [testedIdentity] = await db
      .select()
      .from(platformLoginTests)
      .where(eq(platformLoginTests.id, attempt.id));
    const connection = await readLoginConnection(db, attempt.connection_id);
    await linkTestedIdentity(
      db,
      { ...saved.actor, companyIdentity: context.get('companyIdentity') },
      {
        connectionId: attempt.connection_id,
        revision: attempt.revision,
        testId: attempt.id,
        activeOnly: true,
      },
    );
    if (connection?.kind === 'github' && testedIdentity) {
      await preserveLegacyLoginEffects(db, {
        connectionKind: connection.kind,
        userId: saved.actor.userId,
        identity: {
          issuer: testedIdentity.issuer,
          subject: testedIdentity.subject,
          login: testedIdentity.login,
          email: null,
          emailVerified: false,
          groups: [],
        },
      });
    }
    await db.delete(platformLoginTests).where(eq(platformLoginTests.id, attempt.id));
    deleteCookie(context, 'void_link_confirm', { path: '/auth/link/confirm' });
    context.header('Cache-Control', 'no-store');
    return platformBrowserPage(
      context,
      'Login method linked',
      browserPageStatus('success') +
        browserPageLead(
          'Login method linked',
          'Your login method is linked. You can close this window and return to Void.',
        ),
    );
  } catch (error) {
    return authenticationError(context, error);
  }
}
