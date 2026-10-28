import {
  createDeployArtifact,
  deployArtifactDigest,
  validateManifestShape,
  type DeployArtifact,
} from '@void/deploy-core';
import { browserPageLead, escapeBrowserHtml } from '@void/platform/browser-page';
import { and, eq, gt, isNull, desc } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readAuthSettings, readEnabledLoginConnections } from '../auth/configuration.ts';
import { signJwt, verifyJwt } from '../auth/jwt.ts';
import type { OAuthRequestData, OAuthSession, OAuthScope } from '../auth/oauth-types.ts';
import {
  activeOAuthClient,
  activeOAuthGrant,
  authenticateOAuthClient,
  oauthBearer,
  OAuthError,
} from '../auth/oauth.ts';
import { createCodeChallenge, isValidCodeVerifier } from '../auth/pkce.ts';
import { hashLoginProof, randomLoginProof } from '../auth/proofs.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { platformBrowserPage, platformBrowserError } from '../browser-page.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { consumeCliAuthCode, getProjectBySlug, getUser } from '../db.ts';
import { isDevBypass, type ApiEnv } from '../env.ts';
import { MAX_SLUG_LENGTH } from '../project-names.ts';
import { oauthClients, oauthGrants, oauthRefreshTokens, oauthRequests } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import previews from './previews.ts';
import { createUserProject } from './projects.ts';

const app = new Hono<ApiEnv>();
const FLOW_SECONDS = 300;
const TOKEN_SECONDS = 3600;
// Absolute lifetime of an identity grant's refresh token family. Rotation
// never extends it; it only shrinks toward the underlying login session's
// own expiry (session.exp).
const REFRESH_TOKEN_MAX_SECONDS = 60 * 60 * 24 * 90;
const browserCookie = 'void_oauth_browser';
const userCookie = 'void_oauth_user';
const until = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const h = escapeBrowserHtml;
export function oauthMetadata(context: Context<ApiEnv>) {
  const issuer = origin(context);
  return context.json({
    issuer,
    authorization_endpoint: issuer + '/oauth/authorize',
    token_endpoint: issuer + '/oauth/token',
    revocation_endpoint: issuer + '/oauth/revoke',
    userinfo_endpoint: issuer + '/oauth/userinfo',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: ['profile', 'deploy:approve', 'preview:deploy'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  });
}
function origin(context: Context<ApiEnv>) {
  if (!context.env.AUTH_REDIRECT_URI) {
    throw new OAuthError('server_error', 'The platform authentication URL is not configured.');
  }
  return new URL(context.env.AUTH_REDIRECT_URI).origin;
}
function cookieOptions(context: Context<ApiEnv>, maxAge: number) {
  return {
    httpOnly: true,
    secure: !isDevBypass(context.env),
    sameSite: 'Lax' as const,
    path: '/oauth',
    maxAge,
  };
}
async function userSession(context: Context<ApiEnv>): Promise<OAuthSession | null> {
  const token = getCookie(context, userCookie);
  const payload = token ? await verifyJwt(token, context.env.JWT_SECRET, 'api') : null;
  if (
    !payload ||
    !(await validateHumanSession(context.get('db'), payload, context.get('companyIdentity')))
  ) {
    return null;
  }
  const user = await getUser(context.get('db'), payload.sub);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return null;
  }
  context.set('user', user);
  return {
    sub: payload.sub,
    sid: payload.sid,
    aud: 'api',
    exp: payload.exp,
    companyIdentity: context.get('companyIdentity'),
  };
}
function requireBrowserOrigin(context: Context<ApiEnv>) {
  const expected = origin(context);
  const requestOrigin = new URL(context.req.url).origin;
  // Wrangler's local proxy strips the port from same-origin browser headers.
  const localProxy = isDevBypass(context.env) && new URL(requestOrigin).hostname === 'localhost';
  if (
    context.req.header('Origin') !== expected &&
    !(localProxy && context.req.header('Origin') === requestOrigin)
  ) {
    throw new OAuthError('access_denied', 'Invalid request origin.', 403);
  }
}
async function browserRequest(context: Context<ApiEnv>, id: string) {
  const [request] = await context
    .get('db')
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.id, id), gt(oauthRequests.expires_at, new Date().toISOString())));
  const proof = getCookie(context, browserCookie);
  if (!request || !proof || request.browser_hash !== (await hashLoginProof(proof))) {
    throw new OAuthError(
      'access_denied',
      'This request expired. Start again from the application.',
      403,
    );
  }
  return request;
}
function validateAuthorization(
  client: typeof oauthClients.$inferSelect,
  redirect: unknown,
  state: unknown,
  challenge: unknown,
  local: boolean,
) {
  if (
    typeof redirect !== 'string' ||
    !client.redirect_uris.includes(redirect) ||
    (!redirect.startsWith('https:') && !local) ||
    typeof state !== 'string' ||
    state.length < 16 ||
    state.length > 256 ||
    typeof challenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  ) {
    throw new OAuthError(
      'invalid_request',
      'An exact registered redirect URL, state, and S256 PKCE challenge are required.',
    );
  }
}
async function newRequest(
  context: Context<ApiEnv>,
  clientId: string | null,
  data: OAuthRequestData,
  bindBrowser: boolean,
) {
  const proof = randomLoginProof();
  const [request] = await context
    .get('db')
    .insert(oauthRequests)
    .values({
      id: crypto.randomUUID(),
      client_id: clientId,
      browser_hash: bindBrowser ? await hashLoginProof(proof) : '',
      data,
      expires_at: until(FLOW_SECONDS),
    })
    .returning();
  if (bindBrowser) {
    setCookie(context, browserCookie, proof, cookieOptions(context, FLOW_SECONDS));
  }
  return request!;
}
async function loginPage(context: Context<ApiEnv>, id: string) {
  const settings = await readAuthSettings(context.get('db'));
  const capabilities = getPlatformCapabilities(context.env);
  const methods = isDevBypass(context.env)
    ? [{ id: 'local', label: 'Continue locally' }]
    : settings
      ? (await readEnabledLoginConnections(context.get('db'))).map(({ configuration }) => ({
          id: configuration.id,
          label: configuration.label,
        }))
      : [
          ...(capabilities.githubOAuth ? [{ id: 'github', label: 'GitHub' }] : []),
          ...(capabilities.googleOAuth ? [{ id: 'google', label: 'Google' }] : []),
        ];
  return platformBrowserPage(
    context,
    'Sign in to Void',
    browserPageLead('Sign in to Void', 'Choose your platform login method.') +
      '<div class="void-auth-actions">' +
      methods
        .map(
          (method) =>
            `<a class="void-auth-button void-auth-button-primary" href="/oauth/login?request=${h(id)}&amp;provider=${h(encodeURIComponent(method.id))}">${h(method.label)}</a>`,
        )
        .join('') +
      '</div>',
  );
}
async function consentPage(context: Context<ApiEnv>, request: typeof oauthRequests.$inferSelect) {
  const session = await userSession(context);
  if (!session) {
    return loginPage(context, request.id);
  }
  if (request.data.kind === 'connections') {
    return context.redirect('/oauth/connections');
  }
  const client = await activeOAuthClient(context.get('db'), request.client_id!);
  if (request.data.kind === 'deployment') {
    const { grant } = await activeOAuthGrant(
      context.get('db'),
      request.data.grantId!,
      context.get('companyIdentity'),
    );
    if (grant.user_id !== session.sub) {
      throw new OAuthError(
        'access_denied',
        'Sign in with the account that started this publish.',
        403,
      );
    }
  }
  const deploy = request.data.kind === 'deployment';
  const details = deploy
    ? `Publish ${request.data.checkpoint} to ${request.data.slug}. This approval permits one deployment of the prepared artifact. Published code can use the project’s existing secrets and resources.`
    : request.data.scopes?.includes('preview:deploy')
      ? 'Read your user ID and username, and build private previews with separate resources and no production secrets. Production publishing still requires your approval for each artifact.'
      : 'Read your user ID and username. Project access requires separate approval for each publish.';
  const artifact = request.data.artifact;
  const summary = artifact
    ? `<p>Resources: ${h(Object.keys(artifact.manifest.bindings).join(', ') || 'none')}. ${Object.keys(artifact.assetManifest).length} assets; ${request.data.workerModules?.length ?? 0} Worker modules.</p><details><summary>Deployment details</summary><pre>${h(JSON.stringify(artifact.manifest, null, 2))}</pre><p>Artifact: ${h(request.data.artifactDigest!)}</p></details>`
    : '';
  // Chrome makes same-origin form Origin opaque under no-referrer. Keep the
  // strict Origin check while suppressing referrers to every external client.
  context.header('Referrer-Policy', 'same-origin');
  return platformBrowserPage(
    context,
    deploy ? 'Approve publish' : 'Connect application',
    browserPageLead(
      deploy ? 'Approve publish' : 'Connect application',
      `${client.name} by ${client.operator}`,
    ) +
      `<p>${h(new URL(request.data.redirectUri).origin)}</p><p>Signed in as ${h(context.get('user').login)}.</p><p>${h(details)}</p>${summary}<form class="void-auth-actions" method="post" action="/oauth/approve"><input type="hidden" name="request" value="${h(request.id)}"><button class="void-auth-button void-auth-button-primary" name="decision" value="approve">${deploy ? 'Approve publish' : 'Connect'}</button><button class="void-auth-button" name="decision" value="deny">Cancel</button></form>`,
  );
}
app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  context.header('Referrer-Policy', 'no-referrer');
  await next();
});
app.use('*', (context, next) =>
  context.req.path.startsWith('/oauth/preview-serve/')
    ? next()
    : bodyLimit({
        maxSize: ['/oauth/deployment-requests', '/oauth/preview-deployment-requests'].includes(
          context.req.path,
        )
          ? 48 * 1024 * 1024
          : 32768,
      })(context, next),
);
app.onError((error, context) =>
  error instanceof OAuthError
    ? context.req.header('Accept')?.includes('text/html')
      ? platformBrowserError(context, 'Authorization failed', error.message, error.status)
      : context.json({ error: error.code, error_description: error.message }, error.status)
    : platformBrowserError(
        context,
        'Authorization failed',
        'Start again from the application.',
        400,
      ),
);

app.get('/authorize', async (context) => {
  if (context.req.query('request')) {
    const id = context.req.query('request')!;
    const [pending] = await context
      .get('db')
      .select()
      .from(oauthRequests)
      .where(
        and(
          eq(oauthRequests.id, id),
          gt(oauthRequests.expires_at, new Date().toISOString()),
          isNull(oauthRequests.approved_at),
        ),
      );
    if (!pending) {
      throw new OAuthError('invalid_request', 'This request expired.');
    }
    if (!pending.browser_hash) {
      const proof = randomLoginProof();
      const [bound] = await context
        .get('db')
        .update(oauthRequests)
        .set({ browser_hash: await hashLoginProof(proof) })
        .where(and(eq(oauthRequests.id, id), eq(oauthRequests.browser_hash, '')))
        .returning();
      if (!bound) {
        throw new OAuthError('invalid_request', 'This request has already been opened.');
      }
      setCookie(context, browserCookie, proof, cookieOptions(context, FLOW_SECONDS));
      return consentPage(context, bound);
    }
    return consentPage(context, await browserRequest(context, id));
  }
  if (
    context.req.query('response_type') !== 'code' ||
    context.req.query('code_challenge_method') !== 'S256'
  ) {
    throw new OAuthError(
      'invalid_request',
      'Use the authorization code flow with profile scope and S256 PKCE.',
    );
  }
  const client = await activeOAuthClient(context.get('db'), context.req.query('client_id') ?? '');
  const scopes = (context.req.query('scope') ?? '').split(' ') as Array<OAuthScope>;
  if (
    !scopes.includes('profile') ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) => !['profile', 'preview:deploy'].includes(scope) || !client.scopes.includes(scope),
    )
  ) {
    throw new OAuthError(
      'invalid_scope',
      'Request only enabled identity and private preview permissions.',
    );
  }
  const redirectUri = context.req.query('redirect_uri')!;
  const state = context.req.query('state')!;
  const challenge = context.req.query('code_challenge')!;
  validateAuthorization(client, redirectUri, state, challenge, isDevBypass(context.env));
  return consentPage(
    context,
    await newRequest(
      context,
      client.id,
      { kind: 'profile', scopes, redirectUri, state, challenge },
      true,
    ),
  );
});

app.get('/login', async (context) => {
  const request = await browserRequest(context, context.req.query('request') ?? '');
  const verifier = randomLoginProof();
  await context
    .get('db')
    .update(oauthRequests)
    .set({ data: { ...request.data, loginVerifier: verifier } })
    .where(eq(oauthRequests.id, request.id));
  const callback = new URL('/oauth/login/callback', origin(context));
  callback.searchParams.set('state', request.id);
  const target = new URL('/auth/login', origin(context));
  target.searchParams.set('redirect', callback.href);
  target.searchParams.set('provider', context.req.query('provider') ?? '');
  target.searchParams.set('code_challenge', await createCodeChallenge(verifier));
  target.searchParams.set('code_challenge_method', 'S256');
  if (isDevBypass(context.env) && context.req.query('provider') === 'local') {
    const { users } = await import('../schema.ts');
    const [user] = await context.get('db').select().from(users).limit(1);
    if (!user) {
      throw new OAuthError('access_denied', 'Create a local platform user first.');
    }
    const token = await signJwt(
      { sub: user.id, login: user.login, aud: 'api' },
      context.env.JWT_SECRET,
      { ttlSeconds: TOKEN_SECONDS },
    );
    setCookie(context, userCookie, token, cookieOptions(context, TOKEN_SECONDS));
    return context.redirect('/oauth/authorize?request=' + request.id);
  }
  return context.redirect(target.href);
});

app.get('/login/callback', async (context) => {
  const request = await browserRequest(context, context.req.query('state') ?? '');
  if (!request.data.loginVerifier || !context.req.query('code')) {
    throw new OAuthError('invalid_request', 'Sign-in expired.');
  }
  const token = await consumeCliAuthCode(
    context.get('db'),
    context.req.query('code')!,
    request.id,
    await createCodeChallenge(request.data.loginVerifier),
    'S256',
  );
  const payload = token ? await verifyJwt(token, context.env.JWT_SECRET, 'api') : null;
  if (
    !payload ||
    !(await validateHumanSession(context.get('db'), payload, context.get('companyIdentity')))
  ) {
    throw new OAuthError('access_denied', 'Sign-in expired.', 401);
  }
  setCookie(
    context,
    userCookie,
    token!,
    cookieOptions(context, Math.min(TOKEN_SECONDS, payload.exp - Math.floor(Date.now() / 1000))),
  );
  const { loginVerifier: _verifier, ...data } = request.data;
  await context
    .get('db')
    .update(oauthRequests)
    .set({ data })
    .where(eq(oauthRequests.id, request.id));
  return context.redirect('/oauth/authorize?request=' + request.id);
});

app.post('/approve', async (context) => {
  requireBrowserOrigin(context);
  const body = await context.req.parseBody();
  const request = await browserRequest(context, String(body.request ?? ''));
  const session = await userSession(context);
  if (!session || request.data.kind === 'connections') {
    throw new OAuthError('access_denied', 'Sign in again.', 401);
  }
  const code = randomLoginProof();
  await context.get('db').transaction(async (tx) => {
    const client = await activeOAuthClient(tx, request.client_id!, true);
    if (
      request.data.kind === 'profile' &&
      request.data.scopes?.some((scope) => !client.scopes.includes(scope))
    ) {
      throw new OAuthError('invalid_scope', 'The requested permission is no longer enabled.', 403);
    }
    if (request.data.kind === 'deployment') {
      const { grant } = await activeOAuthGrant(
        tx,
        request.data.grantId!,
        context.get('companyIdentity'),
        true,
      );
      if (
        grant.user_id !== session.sub ||
        grant.client_id !== client.id ||
        !client.scopes.includes('deploy:approve')
      ) {
        throw new OAuthError('access_denied', 'This publish is unavailable.', 403);
      }
    }
    const [locked] = await tx
      .select()
      .from(oauthRequests)
      .where(
        and(
          eq(oauthRequests.id, request.id),
          isNull(oauthRequests.approved_at),
          isNull(oauthRequests.consumed_at),
          gt(oauthRequests.expires_at, new Date().toISOString()),
        ),
      )
      .for('update');
    if (!locked) {
      throw new OAuthError('invalid_request', 'This request was already handled.');
    }
    if (body.decision !== 'approve') {
      await tx
        .update(oauthRequests)
        .set({ consumed_at: new Date().toISOString() })
        .where(eq(oauthRequests.id, request.id));
      return;
    }
    let data = locked.data;
    if (data.kind === 'deployment') {
      let project = await getProjectBySlug(tx, data.slug!);
      if (
        project &&
        (project.user_id !== session.sub ||
          project.status !== 'active' ||
          project.preview_client_id)
      ) {
        throw new OAuthError('access_denied', 'You must own the selected project.', 403);
      }
      if (!project) {
        const original = context.get('db');
        context.set('db', tx as typeof original);
        try {
          const result = await createUserProject(context, { slug: data.slug! });
          if (!result.ok) {
            const payload = (await result.json()) as { error: string };
            throw new OAuthError('invalid_request', payload.error);
          }
          project = (await result.json()) as NonNullable<typeof project>;
        } finally {
          context.set('db', original);
        }
      }
      data = { ...data, projectId: project.id };
    } else {
      const grantId = crypto.randomUUID();
      await tx.insert(oauthGrants).values({
        id: grantId,
        client_id: client.id,
        user_id: session.sub,
        session,
        scopes: data.scopes ?? ['profile'],
        token_hash: await hashLoginProof(randomLoginProof()),
        expires_at: new Date(
          Math.min(Date.now() + TOKEN_SECONDS * 1000, session.exp * 1000),
        ).toISOString(),
      });
      data = { ...data, grantId };
    }
    await tx
      .update(oauthRequests)
      .set({
        user_id: session.sub,
        data,
        approved_at: new Date().toISOString(),
        code_hash: await hashLoginProof(code),
        code_expires_at: until(FLOW_SECONDS),
        expires_at: until(data.kind === 'deployment' ? 900 : FLOW_SECONDS),
      })
      .where(eq(oauthRequests.id, request.id));
  });
  const redirect = new URL(request.data.redirectUri);
  redirect.searchParams.set('state', request.data.state);
  if (body.decision === 'approve') {
    redirect.searchParams.set('code', code);
  } else {
    redirect.searchParams.set('error', 'access_denied');
  }
  deleteCookie(context, browserCookie, cookieOptions(context, 0));
  return context.redirect(redirect.href);
});

app.post('/token', async (context) => {
  const client = await authenticateOAuthClient(
    context.get('db'),
    context.req.header('Authorization'),
  );
  const form = await context.req.parseBody();
  if (form.grant_type === 'refresh_token') {
    if (typeof form.refresh_token !== 'string' || !form.refresh_token) {
      throw new OAuthError('invalid_request', 'A refresh token is required.');
    }
    const db = context.get('db');
    const presentedHash = await hashLoginProof(form.refresh_token);
    // Claim the token atomically, outside any transaction that might later
    // roll back: once a redemption attempt is made, the token must stay
    // burned even if a later check (client, session, scope) rejects it.
    const [claimed] = await db
      .update(oauthRefreshTokens)
      .set({ used_at: new Date().toISOString() })
      .where(
        and(
          eq(oauthRefreshTokens.token_hash, presentedHash),
          isNull(oauthRefreshTokens.used_at),
          gt(oauthRefreshTokens.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    if (!claimed) {
      const [existing] = await db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.token_hash, presentedHash));
      if (existing?.used_at) {
        // Redeeming an already-rotated-out refresh token is treated as
        // theft: revoke the whole grant, not just this token.
        await db
          .update(oauthGrants)
          .set({ revoked_at: new Date().toISOString() })
          .where(eq(oauthGrants.id, existing.grant_id));
      }
      throw new OAuthError(
        'invalid_grant',
        'The refresh token is invalid, expired, or was already used.',
      );
    }
    return db.transaction(async (tx) => {
      const { grant } = await activeOAuthGrant(
        tx,
        claimed.grant_id,
        context.get('companyIdentity'),
        true,
        false,
      );
      if (grant.client_id !== client.id) {
        throw new OAuthError('invalid_grant', 'Application access was revoked.');
      }
      let scopes = grant.scopes;
      if (typeof form.scope === 'string' && form.scope) {
        const requested = form.scope.split(' ').filter(Boolean) as Array<OAuthScope>;
        if (
          !requested.length ||
          new Set(requested).size !== requested.length ||
          requested.some((scope) => !grant.scopes.includes(scope))
        ) {
          throw new OAuthError(
            'invalid_scope',
            'The requested permission exceeds the granted access.',
          );
        }
        scopes = requested;
      }
      const refreshToken = randomLoginProof();
      await tx.insert(oauthRefreshTokens).values({
        id: crypto.randomUUID(),
        grant_id: grant.id,
        token_hash: await hashLoginProof(refreshToken),
        // Carried forward unchanged: rotation never extends the family's
        // absolute lifetime.
        expires_at: claimed.expires_at,
      });
      const accessToken = randomLoginProof();
      const expiresAt = new Date(
        Math.min(Date.now() + TOKEN_SECONDS * 1000, grant.session.exp * 1000),
      ).toISOString();
      await tx
        .update(oauthGrants)
        .set({ token_hash: await hashLoginProof(accessToken), expires_at: expiresAt, scopes })
        .where(eq(oauthGrants.id, grant.id));
      return context.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
        scope: scopes.join(' '),
      });
    });
  }
  if (
    form.grant_type !== 'authorization_code' ||
    typeof form.code !== 'string' ||
    !isValidCodeVerifier(form.code_verifier) ||
    typeof form.redirect_uri !== 'string'
  ) {
    throw new OAuthError(
      'invalid_grant',
      'An authorization code, redirect URI, and PKCE verifier are required.',
    );
  }
  const challenge = await createCodeChallenge(form.code_verifier);
  const accessToken = randomLoginProof();
  return context.get('db').transaction(async (tx) => {
    await activeOAuthClient(tx, client.id, true);
    const [request] = await tx
      .select()
      .from(oauthRequests)
      .where(
        and(
          eq(oauthRequests.code_hash, await hashLoginProof(form.code as string)),
          eq(oauthRequests.client_id, client.id),
          isNull(oauthRequests.consumed_at),
          gt(oauthRequests.code_expires_at, new Date().toISOString()),
        ),
      )
      .for('update');
    if (
      !request ||
      !request.approved_at ||
      request.data.redirectUri !== form.redirect_uri ||
      request.data.challenge !== challenge ||
      !request.data.grantId
    ) {
      throw new OAuthError(
        'invalid_grant',
        'The authorization code is invalid, expired, or belongs to another request.',
      );
    }
    const { grant } = await activeOAuthGrant(
      tx,
      request.data.grantId,
      context.get('companyIdentity'),
      true,
    );
    if (grant.user_id !== request.user_id || grant.client_id !== client.id) {
      throw new OAuthError('invalid_grant', 'Application access was revoked.');
    }
    await tx
      .update(oauthRequests)
      .set({ consumed_at: new Date().toISOString() })
      .where(eq(oauthRequests.id, request.id));
    if (request.data.kind === 'deployment') {
      const token = await signJwt(
        {
          sub: grant.user_id,
          login: '',
          aud: 'oauth-deploy',
          project: request.data.projectId,
          oauthApproval: request.id,
        },
        context.env.JWT_SECRET,
        {
          ttlSeconds: Math.max(1, Math.floor((Date.parse(request.expires_at) - Date.now()) / 1000)),
        },
      );
      return context.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: Math.floor((Date.parse(request.expires_at) - Date.now()) / 1000),
        scope: 'deploy:approve',
        project_id: request.data.projectId,
        approval_id: request.id,
      });
    }
    await tx
      .update(oauthGrants)
      .set({ token_hash: await hashLoginProof(accessToken) })
      .where(eq(oauthGrants.id, grant.id));
    const refreshToken = randomLoginProof();
    await tx.insert(oauthRefreshTokens).values({
      id: crypto.randomUUID(),
      grant_id: grant.id,
      token_hash: await hashLoginProof(refreshToken),
      expires_at: new Date(
        Math.min(Date.now() + REFRESH_TOKEN_MAX_SECONDS * 1000, grant.session.exp * 1000),
      ).toISOString(),
    });
    return context.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000)),
      scope: grant.scopes.join(' '),
    });
  });
});

app.get('/userinfo', async (context) => {
  const { user, grant } = await oauthBearer(
    context.get('db'),
    context.req.header('Authorization'),
    context.get('companyIdentity'),
  );
  return context.json({
    sub: user.id,
    preferred_username: user.login,
    scope: grant.scopes.join(' '),
  });
});
app.post('/revoke', async (context) => {
  const client = await authenticateOAuthClient(
    context.get('db'),
    context.req.header('Authorization'),
  );
  const body = await context.req.parseBody();
  if (typeof body.token === 'string') {
    const hash = await hashLoginProof(body.token);
    await context.get('db').transaction(async (tx) => {
      const [byAccessToken] = await tx
        .update(oauthGrants)
        .set({ revoked_at: new Date().toISOString() })
        .where(and(eq(oauthGrants.client_id, client.id), eq(oauthGrants.token_hash, hash)))
        .returning({ id: oauthGrants.id });
      if (byAccessToken) {
        return;
      }
      const [byRefreshToken] = await tx
        .select({ grantId: oauthGrants.id })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthRefreshTokens.grant_id))
        .where(and(eq(oauthRefreshTokens.token_hash, hash), eq(oauthGrants.client_id, client.id)));
      if (byRefreshToken) {
        await tx
          .update(oauthGrants)
          .set({ revoked_at: new Date().toISOString() })
          .where(eq(oauthGrants.id, byRefreshToken.grantId));
      }
    });
  }
  return context.body(null, 200);
});

app.post('/deployment-requests', async (context) => {
  const { grant } = await oauthBearer(
    context.get('db'),
    context.req.header('Authorization'),
    context.get('companyIdentity'),
  );
  const client = await activeOAuthClient(context.get('db'), grant.client_id);
  if (!client.scopes.includes('deploy:approve')) {
    throw new OAuthError('invalid_scope', 'Publishing is not enabled for this application.', 403);
  }
  const body = await context.req.json<{
    redirect_uri: string;
    state: string;
    code_challenge: string;
    code_challenge_method: string;
    slug: string;
    checkpoint: string;
    artifact: DeployArtifact;
  }>();
  validateAuthorization(
    client,
    body.redirect_uri,
    body.state,
    body.code_challenge,
    isDevBypass(context.env),
  );
  if (
    body.code_challenge_method !== 'S256' ||
    typeof body.slug !== 'string' ||
    body.slug.length > MAX_SLUG_LENGTH ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug) ||
    typeof body.checkpoint !== 'string' ||
    !body.checkpoint ||
    body.checkpoint.length > 160 ||
    !body.artifact ||
    body.artifact.artifactVersion !== 1 ||
    validateManifestShape(body.artifact.manifest) ||
    !body.artifact.assetManifest ||
    typeof body.artifact.assetManifest !== 'object' ||
    Array.isArray(body.artifact.assetManifest)
  ) {
    throw new OAuthError(
      'invalid_request',
      'Provide a project name, checkpoint, and valid prepared deployment artifact.',
    );
  }
  const artifact = createDeployArtifact(body.artifact);
  const data: OAuthRequestData = {
    kind: 'deployment',
    grantId: grant.id,
    redirectUri: body.redirect_uri,
    state: body.state,
    challenge: body.code_challenge,
    slug: body.slug,
    checkpoint: body.checkpoint,
    artifactDigest: await deployArtifactDigest(artifact),
    artifact: createDeployArtifact({
      manifest: artifact.manifest,
      assetManifest: artifact.assetManifest,
    }),
    workerModules: Object.keys(artifact.workerFiles ?? {}),
  };
  const request = await newRequest(context, client.id, data, false);
  return context.json(
    {
      authorization_url: origin(context) + '/oauth/authorize?request=' + request.id,
      request_id: request.id,
      expires_in: FLOW_SECONDS,
    },
    201,
  );
});

app.get('/connections', async (context) => {
  const session = await userSession(context);
  if (!session) {
    const request = await newRequest(
      context,
      null,
      { kind: 'connections', redirectUri: '', state: '', challenge: '' },
      true,
    );
    return loginPage(context, request.id);
  }
  const grants = await context
    .get('db')
    .select({ grant: oauthGrants, client: oauthClients })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.client_id))
    .where(
      and(
        eq(oauthGrants.user_id, session.sub),
        isNull(oauthGrants.revoked_at),
        gt(oauthGrants.expires_at, new Date().toISOString()),
      ),
    )
    .orderBy(desc(oauthGrants.created_at));
  context.header('Referrer-Policy', 'same-origin');
  return platformBrowserPage(
    context,
    'Connected apps',
    browserPageLead('Connected apps', context.get('user').login) +
      grants
        .map(
          ({ grant, client }) =>
            `<form method="post" action="/oauth/connections/revoke"><p>${h(client.name)} by ${h(client.operator)}</p><p>${grant.scopes.includes('preview:deploy') ? 'Identity access and private previews.' : 'Identity access.'} Each publish requires approval.</p><input type="hidden" name="grant" value="${h(grant.id)}"><button class="void-auth-button" type="submit">Disconnect</button></form>`,
        )
        .join('') +
      (grants.length ? '' : '<p>No connected apps.</p>'),
  );
});
app.post('/connections/revoke', async (context) => {
  requireBrowserOrigin(context);
  const session = await userSession(context);
  if (!session) {
    throw new OAuthError('access_denied', 'Sign in again.', 401);
  }
  const body = await context.req.parseBody();
  await context
    .get('db')
    .update(oauthGrants)
    .set({ revoked_at: new Date().toISOString() })
    .where(and(eq(oauthGrants.id, String(body.grant ?? '')), eq(oauthGrants.user_id, session.sub)));
  return context.redirect('/oauth/connections');
});
app.route('/', previews);
export default app;
