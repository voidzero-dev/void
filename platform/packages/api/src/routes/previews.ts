import {
  createDeployArtifact,
  deployArtifactDigest,
  validateManifestShape,
  type DeployArtifact,
} from '@void/deploy-core';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AiLoggingPublishError,
  lockNewProjectAiLoggingInputs,
  publishProjectAiLogging,
} from '../ai-logging.ts';
import { signJwt, verifyJwt } from '../auth/jwt.ts';
import { activeOAuthClient, activeOAuthGrant, oauthBearer, OAuthError } from '../auth/oauth.ts';
import { hashLoginProof, randomLoginProof } from '../auth/proofs.ts';
import { createProject, getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { initialPlanDefaultFor } from '../plans.ts';
import { projectUrl } from '../project-url.ts';
import { oauthRequests, previewTickets, projects, users } from '../schema.ts';
import { lockZeroTrustConfiguration } from '../zero-trust/lock.ts';
import { initializeNewProjectZeroTrust } from '../zero-trust/project.ts';

const app = new Hono<ApiEnv>();
const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const cookieName = '__Host-void-preview';

async function permittedGrant(context: Context<ApiEnv>) {
  const result = await oauthBearer(
    context.get('db'),
    context.req.header('Authorization'),
    context.get('companyIdentity'),
  );
  requirePreviewPermission(result.grant, result.client);
  return result;
}
function requirePreviewPermission(
  grant: Awaited<ReturnType<typeof activeOAuthGrant>>['grant'],
  client: Awaited<ReturnType<typeof activeOAuthClient>>,
) {
  if (!grant.scopes.includes('preview:deploy') || !client.scopes.includes('preview:deploy')) {
    throw new OAuthError('invalid_scope', 'Connect again with private preview permission.', 403);
  }
}
async function ownedPreview(
  context: Context<ApiEnv>,
  id: string,
  grant: Awaited<ReturnType<typeof activeOAuthGrant>>['grant'],
  current?: Awaited<ReturnType<typeof getProject>>,
) {
  const project = current ?? (await getProject(context.get('db'), id));
  if (
    !project ||
    project.status !== 'active' ||
    project.preview_client_id !== grant.client_id ||
    project.user_id !== grant.user_id ||
    Date.parse(project.preview_expires_at!) <= Date.now()
  ) {
    throw new OAuthError('access_denied', 'Preview unavailable.', 404);
  }
  return project;
}

// A stable, isolated destination. Serializing on the owner bounds creation even
// across different clients and overlapping requests; it also fences uninstall.
app.post('/previews', async (context) => {
  const { grant, user } = await permittedGrant(context);
  const body = await context.req.json<{ workspace: string }>();
  if (typeof body.workspace !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspace)) {
    throw new OAuthError('invalid_request', 'Provide a workspace ID.');
  }
  const project = await context.get('db').transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'shared');
    await lockNewProjectAiLoggingInputs(tx);
    await tx.select().from(users).where(eq(users.id, user.id)).for('update');
    const [existing] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.user_id, user.id),
          eq(projects.preview_client_id, grant.client_id),
          eq(projects.preview_workspace_id, body.workspace),
        ),
      )
      .for('update');
    if (existing) {
      if (existing.status !== 'active') {
        throw new OAuthError('access_denied', 'Preview is being removed.', 409);
      }
      const [renewed] = await tx
        .update(projects)
        .set({ preview_expires_at: expiry(7 * 86400) })
        .where(eq(projects.id, existing.id))
        .returning();
      return renewed!;
    }
    const [total] = await tx
      .select({ count: count() })
      .from(projects)
      .where(and(eq(projects.user_id, user.id), sql`${projects.preview_client_id} IS NOT NULL`));
    if (total!.count >= 10) {
      throw new OAuthError(
        'access_denied',
        'Remove an unused preview before creating another (limit 10).',
        403,
      );
    }
    const created = await createProject(
      tx,
      user.id,
      'preview-' + crypto.randomUUID().replaceAll('-', '').slice(0, 20),
    );
    const [preview] = await tx
      .update(projects)
      .set({
        preview_client_id: grant.client_id,
        preview_workspace_id: body.workspace,
        preview_expires_at: expiry(7 * 86400),
      })
      .where(eq(projects.id, created.id))
      .returning();
    // A plan AI logging default applies from the first request; a KV failure
    // rolls the preview back.
    await publishProjectAiLogging(tx, context.env.ROUTING, created.id, {
      trigger: 'preview_create',
      initialPlanDefault: initialPlanDefaultFor(context.env),
      creating: true,
    }).catch((error: unknown) => {
      if (error instanceof AiLoggingPublishError) {
        throw new OAuthError(
          'temporarily_unavailable',
          'The AI logging setting for the new preview could not be applied. Retry.',
          503,
        );
      }
      throw error;
    });
    return preview!;
  });
  await initializeNewProjectZeroTrust(context.env, context.get('db'), project.id);
  return context.json(
    {
      project_id: project.id,
      url: projectUrl(project, context.env),
      deployment_id: project.active_deployment_id,
    },
    201,
  );
});

// Same artifact contract as publishing, but this permission can target only
// the caller's isolated preview. No browser publish approval is fabricated.
app.post('/preview-deployment-requests', async (context) => {
  const { grant, user } = await permittedGrant(context);
  const body = await context.req.json<{
    project_id: string;
    checkpoint: string;
    artifact: DeployArtifact;
  }>();
  const project = await ownedPreview(context, body.project_id, grant);
  if (
    typeof body.checkpoint !== 'string' ||
    !body.checkpoint ||
    body.checkpoint.length > 160 ||
    !body.artifact ||
    body.artifact.artifactVersion !== 1 ||
    validateManifestShape(body.artifact.manifest) ||
    !body.artifact.assetManifest ||
    Array.isArray(body.artifact.assetManifest)
  ) {
    throw new OAuthError(
      'invalid_request',
      'Provide a checkpoint and prepared deployment artifact.',
    );
  }
  const artifact = createDeployArtifact(body.artifact);
  const manifest = artifact.manifest;
  if (
    manifest.auth ||
    manifest.sandbox ||
    manifest.emailProtocolVersion ||
    manifest.schedules?.length ||
    manifest.queues?.length ||
    manifest.bindings.hyperdrive?.length
  ) {
    throw new OAuthError(
      'invalid_request',
      'Private previews support HTTP apps with isolated D1, KV, R2, AI and Durable Objects. Publish to enable authentication, containers, email, schedules, queues or external databases.',
    );
  }
  const id = crypto.randomUUID();
  await context.get('db').transaction(async (tx) => {
    // At most 60 builds per workspace per hour, enforced before upload or provisioning.
    await tx.select().from(projects).where(eq(projects.id, project.id)).for('update');
    const [recent] = await tx
      .select({ count: count() })
      .from(oauthRequests)
      .where(
        and(
          eq(oauthRequests.user_id, user.id),
          sql`${oauthRequests.data}->>'projectId' = ${project.id}`,
          sql`${oauthRequests.expires_at} > now() - interval '45 minutes'`,
        ),
      );
    if (recent!.count >= 60) {
      throw new OAuthError(
        'access_denied',
        'Preview build allowance reached. Try again in an hour.',
        403,
      );
    }
    await tx.insert(oauthRequests).values({
      id,
      client_id: grant.client_id,
      user_id: user.id,
      browser_hash: '',
      data: {
        kind: 'preview',
        grantId: grant.id,
        projectId: project.id,
        checkpoint: body.checkpoint,
        redirectUri: '',
        state: '',
        challenge: '',
        artifactDigest: await deployArtifactDigest(artifact),
        artifact: createDeployArtifact({
          manifest: artifact.manifest,
          assetManifest: artifact.assetManifest,
        }),
        workerModules: Object.keys(artifact.workerFiles ?? {}),
      },
      approved_at: new Date().toISOString(),
      consumed_at: new Date().toISOString(),
      expires_at: new Date(
        Math.min(Date.now() + 900000, Date.parse(grant.expires_at)),
      ).toISOString(),
    });
  });
  const token = await signJwt(
    { sub: user.id, login: '', aud: 'oauth-preview', project: project.id, oauthApproval: id },
    context.env.JWT_SECRET,
    {
      ttlSeconds: Math.max(
        1,
        Math.min(900, Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000)),
      ),
    },
  );
  return context.json({ access_token: token, project_id: project.id, approval_id: id }, 201);
});

app.post('/previews/:id/launch', async (context) => {
  const { grant } = await permittedGrant(context);
  const project = await ownedPreview(context, context.req.param('id'), grant);
  if (!project.active_deployment_id) {
    throw new OAuthError('access_denied', 'The first preview build is not ready yet.', 409);
  }
  const ticket = randomLoginProof();
  await context
    .get('db')
    .insert(previewTickets)
    .values({
      token_hash: await hashLoginProof(ticket),
      project_id: project.id,
      grant_id: grant.id,
      expires_at: expiry(60),
    });
  const url = new URL(projectUrl(project, context.env));
  url.searchParams.set('__void_preview', ticket);
  return context.json({ url: url.href });
});

app.all('/preview-serve/:id', async (context) => {
  const original = context.req.header('X-Void-Preview-URL');
  if (!original || !context.env.PREVIEW_DISPATCH) {
    throw new OAuthError('access_denied', 'Preview unavailable.', 404);
  }
  const url = new URL(original);
  const project = await getProject(context.get('db'), context.req.param('id'));
  if (
    !project?.preview_client_id ||
    url.origin !== projectUrl(project, context.env) ||
    project.status !== 'active'
  ) {
    throw new OAuthError('access_denied', 'Preview unavailable.', 404);
  }
  const ticket = url.searchParams.get('__void_preview');
  if (ticket && context.req.method === 'GET') {
    const [receipt] = await context
      .get('db')
      .delete(previewTickets)
      .where(
        and(
          eq(previewTickets.token_hash, await hashLoginProof(ticket)),
          eq(previewTickets.project_id, project.id),
          gt(previewTickets.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    if (!receipt) {
      throw new OAuthError('invalid_token', 'Reopen the preview from your application.', 401);
    }
    const { grant, user, client } = await activeOAuthGrant(context.get('db'), receipt.grant_id);
    requirePreviewPermission(grant, client);
    await ownedPreview(context, project.id, grant, project);
    const seconds = Math.min(3600, Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000));
    const token = await signJwt(
      {
        sub: user.id,
        login: '',
        aud: 'oauth-preview-view',
        project: project.id,
        oauthGrant: grant.id,
      },
      context.env.JWT_SECRET,
      { ttlSeconds: seconds },
    );
    // No credential-bearing URL is served to generated code or kept in history.
    context.header(
      'Set-Cookie',
      `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${seconds}`,
    );
    context.header('Referrer-Policy', 'no-referrer');
    return context.redirect(url.origin + '/', 303);
  }
  const proof = await verifyJwt(
    getCookie(context, cookieName) ?? '',
    context.env.JWT_SECRET,
    'oauth-preview-view',
  );
  if (!proof?.oauthGrant || proof.project !== project.id) {
    throw new OAuthError('invalid_token', 'Reopen the preview from your application.', 401);
  }
  const { grant, user, client } = await activeOAuthGrant(context.get('db'), proof.oauthGrant);
  requirePreviewPermission(grant, client);
  await ownedPreview(context, project.id, grant, project);
  if (proof.sub !== user.id) {
    throw new OAuthError('invalid_token', 'Preview unavailable.', 401);
  }
  const headers = new Headers(context.req.raw.headers);
  if (
    (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) ||
      headers.get('Upgrade')?.toLowerCase() === 'websocket') &&
    headers.get('Origin') !== url.origin
  ) {
    throw new OAuthError('access_denied', 'Invalid preview request origin.', 403);
  }
  for (const key of context.req.raw.headers.keys()) {
    if (
      key === 'cookie' ||
      key === 'authorization' ||
      key.startsWith('cf-access-') ||
      key.startsWith('x-void-')
    ) {
      headers.delete(key);
    }
  }
  headers.set('Host', url.host);
  const response = await context.env.PREVIEW_DISPATCH.fetch(
    new Request(url, {
      method: context.req.method,
      headers,
      body: context.req.raw.body,
      redirect: 'manual',
    }),
  );
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('Set-Cookie');
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
});

export default app;
