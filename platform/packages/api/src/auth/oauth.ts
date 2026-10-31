import { deployArtifactDigest, createDeployArtifact, type DeployArtifact } from '@void/deploy-core';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  oauthRequests,
  previewTickets,
  users,
  projects,
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { OAuthScope } from './oauth-types.ts';
import { hashLoginProof, randomLoginProof } from './proofs.ts';
import { validateHumanSession, validHumanSessionSnapshot } from './sessions.ts';

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
export function validRedirectUri(value: unknown, local = false): value is string {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) &&
      url.href === value
    );
  } catch {
    return false;
  }
}
export async function registerOAuthClient(
  db: Db,
  input: { name: unknown; operator: unknown; redirectUris: unknown; scopes: unknown },
  local = false,
) {
  const { name, operator, redirectUris, scopes } = input;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 80 ||
    typeof operator !== 'string' ||
    !operator.trim() ||
    operator.length > 160 ||
    !Array.isArray(redirectUris) ||
    !redirectUris.length ||
    redirectUris.length > 10 ||
    redirectUris.some((value) => !validRedirectUri(value, local)) ||
    new Set(redirectUris).size !== redirectUris.length ||
    !Array.isArray(scopes) ||
    !scopes.includes('profile') ||
    scopes.some((value) => !['profile', 'deploy:approve', 'preview:deploy'].includes(value)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new OAuthError(
      'invalid_client_metadata',
      'Enter an app name, operator, exact HTTPS redirect URLs, and supported permissions.',
    );
  }
  const secret = randomLoginProof();
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: crypto.randomUUID(),
      name: name.trim(),
      operator: operator.trim(),
      redirect_uris: redirectUris,
      scopes: scopes as Array<OAuthScope>,
      secret_hash: await hashLoginProof(secret),
    })
    .returning();
  return { client: publicOAuthClient(client!), clientSecret: secret };
}
export function publicOAuthClient(client: typeof oauthClients.$inferSelect) {
  const { secret_hash: _secret, ...value } = client;
  return value;
}
export async function setOAuthPreviewPermission(db: Db, id: string, enabled: boolean) {
  return db.transaction(async (tx) => {
    const [client] = await tx
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id))
      .for('update');
    if (!client?.enabled) {
      throw new OAuthError('invalid_client', 'Application not found.', 404);
    }
    const scopes: Array<OAuthScope> = client.scopes.filter((scope) => scope !== 'preview:deploy');
    if (enabled) {
      scopes.push('preview:deploy');
    }
    await tx.update(oauthClients).set({ scopes }).where(eq(oauthClients.id, id));
    if (!enabled) {
      await tx
        .update(projects)
        .set({ preview_expires_at: new Date().toISOString() })
        .where(eq(projects.preview_client_id, id));
    }
    // Changing a client's maximum permission never elevates existing grants.
    return publicOAuthClient({ ...client, scopes });
  });
}
export async function disableOAuthClient(db: Db, id: string) {
  await db.transaction(async (tx) => {
    const [client] = await tx
      .update(oauthClients)
      .set({ enabled: false })
      .where(eq(oauthClients.id, id))
      .returning();
    if (!client) {
      throw new OAuthError('invalid_client', 'Application not found.', 404);
    }
    await tx
      .update(projects)
      .set({ preview_expires_at: new Date().toISOString() })
      .where(eq(projects.preview_client_id, id));
    await tx
      .update(oauthGrants)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthGrants.client_id, id));
    await tx
      .update(oauthRequests)
      .set({ expires_at: new Date().toISOString() })
      .where(eq(oauthRequests.client_id, id));
  });
}
export async function purgeExpiredOAuthRequests(db: Db) {
  await db.delete(previewTickets).where(sql`${previewTickets.expires_at} < now()`);
  await db.execute(sql`DELETE FROM oauth_requests WHERE id IN (
    SELECT id FROM oauth_requests WHERE expires_at < now() - interval '1 day'
    ORDER BY expires_at LIMIT 1000
  )`);
  await db.execute(sql`DELETE FROM oauth_grants WHERE id IN (
    SELECT id FROM oauth_grants WHERE expires_at < now() - interval '1 day'
    ORDER BY expires_at LIMIT 1000
  )`);
  await db.execute(sql`DELETE FROM oauth_refresh_tokens WHERE id IN (
    SELECT id FROM oauth_refresh_tokens WHERE expires_at < now() - interval '1 day'
    ORDER BY expires_at LIMIT 1000
  )`);
}
export async function activeOAuthClient(db: DbOrTx, id: string, lock = false) {
  const query = db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, id), eq(oauthClients.enabled, true)));
  const [client] = await (lock ? query.for('share') : query);
  if (!client) {
    throw new OAuthError('invalid_client', 'This application is unavailable.', 401);
  }
  return client;
}
export async function authenticateOAuthClient(db: Db, authorization?: string) {
  if (!authorization?.startsWith('Basic ')) {
    throw new OAuthError('invalid_client', 'Client authentication is required.', 401);
  }
  let id: string, secret: string;
  try {
    const value = atob(authorization.slice(6));
    const split = value.indexOf(':');
    if (split < 0) {
      throw new Error();
    }
    id = decodeURIComponent(value.slice(0, split));
    secret = decodeURIComponent(value.slice(split + 1));
  } catch {
    throw new OAuthError('invalid_client', 'Invalid client credentials.', 401);
  }
  const client = await activeOAuthClient(db, id);
  if ((await hashLoginProof(secret)) !== client.secret_hash) {
    throw new OAuthError('invalid_client', 'Invalid client credentials.', 401);
  }
  return client;
}
export async function activeOAuthGrant(
  db: DbOrTx,
  id: string,
  companyIdentity?: ApiEnv['Variables']['companyIdentity'],
  lock = false,
  // The refresh grant redeems a grant whose access token has already
  // expired, so it skips the access-token freshness check and relies on the
  // refresh token's own expiry instead.
  requireFreshAccessToken = true,
) {
  if (!lock) {
    return readActiveOAuthGrant(db, eq(oauthGrants.id, id), companyIdentity);
  }
  // Fence changes to the upstream login configuration during publish cutover.
  if (lock) {
    await db
      .select()
      .from(platformAuthSettings)
      .where(eq(platformAuthSettings.singleton, true))
      .for('share');
  }
  const [initial] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, id));
  if (!initial) {
    throw new OAuthError('invalid_token', 'Application access expired or was revoked.', 401);
  }
  const client = await activeOAuthClient(db, initial.client_id, lock);
  const query = db
    .select()
    .from(oauthGrants)
    .where(
      and(
        eq(oauthGrants.id, id),
        isNull(oauthGrants.revoked_at),
        ...(requireFreshAccessToken ? [gt(oauthGrants.expires_at, new Date().toISOString())] : []),
      ),
    );
  const [grant] = await (lock ? query.for('share') : query);
  if (!grant) {
    throw new OAuthError('invalid_token', 'Application access expired or was revoked.', 401);
  }
  const userQuery = db.select().from(users).where(eq(users.id, grant.user_id));
  const [user] = await (lock ? userQuery.for('share') : userQuery);
  if (lock && grant.session.sid) {
    const [session] = await db
      .select()
      .from(platformHumanSessions)
      .where(eq(platformHumanSessions.id, grant.session.sid));
    if (session) {
      // Configuration mutations lock connections before their sessions.
      await db
        .select()
        .from(platformLoginConnections)
        .where(eq(platformLoginConnections.id, session.connection_id))
        .for('share');
      await db
        .select()
        .from(platformHumanSessions)
        .where(eq(platformHumanSessions.id, session.id))
        .for('share');
    }
  }
  if (
    !user ||
    isAdminSuspended(user.suspended_reason) ||
    grant.session.exp <= Date.now() / 1000 ||
    !(await validateHumanSession(
      db as Db,
      grant.session,
      companyIdentity ?? grant.session.companyIdentity,
    ))
  ) {
    throw new OAuthError('invalid_token', 'Sign in to Void again.', 401);
  }
  return { grant, user, client };
}

// Read the authorization snapshot in one uncached query. Do not cache grants:
// disabling a client, revoking a grant or suspending an owner must apply to the
// next asset request as well as to the next page load.
async function readActiveOAuthGrant(
  db: DbOrTx,
  condition: SQL,
  companyIdentity?: ApiEnv['Variables']['companyIdentity'],
) {
  const [row] = await db
    .select({
      grant: oauthGrants,
      user: users,
      client: oauthClients,
      settings: platformAuthSettings,
      humanSession: platformHumanSessions,
      connection: platformLoginConnections,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.client_id))
    .innerJoin(users, eq(users.id, oauthGrants.user_id))
    .leftJoin(platformAuthSettings, eq(platformAuthSettings.singleton, true))
    .leftJoin(
      platformHumanSessions,
      eq(platformHumanSessions.id, sql`${oauthGrants.session}->>'sid'`),
    )
    .leftJoin(
      platformLoginConnections,
      eq(platformLoginConnections.id, platformHumanSessions.connection_id),
    )
    .where(
      and(
        condition,
        isNull(oauthGrants.revoked_at),
        gt(oauthGrants.expires_at, new Date().toISOString()),
      ),
    );
  if (!row) {
    throw new OAuthError('invalid_token', 'Application access expired or was revoked.', 401);
  }
  const { grant, user, client } = row;
  if (!client.enabled) {
    throw new OAuthError('invalid_client', 'This application is unavailable.', 401);
  }
  if (
    isAdminSuspended(user.suspended_reason) ||
    grant.session.exp <= Date.now() / 1000 ||
    !validHumanSessionSnapshot(
      grant.session,
      row.settings,
      row.humanSession && row.connection
        ? { session: row.humanSession, connection: row.connection, user }
        : null,
      companyIdentity ?? grant.session.companyIdentity,
    )
  ) {
    throw new OAuthError('invalid_token', 'Sign in to Void again.', 401);
  }
  return { grant, user, client };
}
export async function oauthBearer(
  db: Db,
  authorization?: string,
  companyIdentity?: ApiEnv['Variables']['companyIdentity'],
) {
  if (!authorization?.startsWith('Bearer ')) {
    throw new OAuthError('invalid_token', 'Application access is required.', 401);
  }
  return readActiveOAuthGrant(
    db,
    eq(oauthGrants.token_hash, await hashLoginProof(authorization.slice(7))),
    companyIdentity,
  );
}
export async function activeOAuthApproval(
  db: DbOrTx,
  id: string,
  companyIdentity?: ApiEnv['Variables']['companyIdentity'],
  lock = false,
) {
  const [approval] = await db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.id, id), gt(oauthRequests.expires_at, new Date().toISOString())));
  if (
    !approval?.approved_at ||
    !approval.consumed_at ||
    !['deployment', 'preview'].includes(approval.data.kind) ||
    !approval.data.grantId ||
    !approval.data.projectId
  ) {
    throw new OAuthError('invalid_token', 'Deployment approval expired or is unavailable.', 401);
  }
  const { grant, user } = await activeOAuthGrant(db, approval.data.grantId, companyIdentity, lock);
  if (lock) {
    const [current] = await db
      .select()
      .from(oauthRequests)
      .where(and(eq(oauthRequests.id, id), gt(oauthRequests.expires_at, new Date().toISOString())))
      .for('share');
    if (!current) {
      throw new OAuthError('invalid_token', 'Deployment approval expired.', 401);
    }
  }
  const client = await activeOAuthClient(db, grant.client_id, lock);
  if (
    !client.scopes.includes(
      approval.data.kind === 'preview' ? 'preview:deploy' : 'deploy:approve',
    ) ||
    (approval.data.kind === 'preview' && !grant.scopes.includes('preview:deploy')) ||
    approval.user_id !== user.id ||
    approval.client_id !== client.id
  ) {
    throw new OAuthError('invalid_token', 'Deployment approval was revoked.', 401);
  }
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, approval.data.projectId), eq(projects.user_id, user.id)));
  if (!project || project.status !== 'active') {
    throw new OAuthError('invalid_token', 'Deployment project is unavailable.', 401);
  }
  if (
    approval.data.kind === 'preview'
      ? project.preview_client_id !== client.id ||
        Date.parse(project.preview_expires_at!) <= Date.now()
      : project.preview_client_id !== null
  ) {
    throw new OAuthError(
      'invalid_token',
      'This credential cannot deploy to the selected project.',
      403,
    );
  }
  return { approval, grant, user };
}
export async function verifyOAuthDeployment(
  db: Db,
  id: string,
  projectId: string,
  key: string | undefined,
  body: Record<string, unknown>,
  companyIdentity?: ApiEnv['Variables']['companyIdentity'],
) {
  const { approval } = await activeOAuthApproval(db, id, companyIdentity);
  if (projectId !== approval.data.projectId || key !== approval.id) {
    throw new OAuthError(
      'invalid_token',
      'This approval authorizes one deployment to its selected project.',
      403,
    );
  }
  const artifact = createDeployArtifact({
    manifest: body.manifest as DeployArtifact['manifest'],
    assetManifest: body.assetManifest as DeployArtifact['assetManifest'],
    workerFiles: body.workerFiles as DeployArtifact['workerFiles'],
  });
  if ((await deployArtifactDigest(artifact)) !== approval.data.artifactDigest) {
    throw new OAuthError(
      'invalid_token',
      'The deployment differs from the artifact approved on Void.',
      403,
    );
  }
}
