import { createDeployArtifact } from '@void/deploy-core';
import { eq } from 'drizzle-orm';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vite-plus/test';
import { computeAssetHash } from '../../src/assets.ts';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import {
  registerOAuthClient,
  disableOAuthClient,
  verifyOAuthDeployment,
  activeOAuthApproval,
  setOAuthPreviewPermission,
} from '../../src/auth/oauth.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { createHumanSession, revokeConnectionSessions } from '../../src/auth/sessions.ts';
import { processDeploymentBatch } from '../../src/deployment-execution.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import {
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  oauthRequests,
  operatorEvents,
  users,
  projects,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createMockExecutionContext,
  mockCfApi,
  readAllEvents,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv & { DEPLOYMENTS_QUEUE?: Queue };
let user: Awaited<ReturnType<typeof createTestUser>>;
let registration: Awaited<ReturnType<typeof registerOAuthClient>>;
const origin = 'https://platform.example.com';
const redirect = 'https://build.example.com/auth/callback';
const verifier = 'v'.repeat(64);
const state = 's'.repeat(32);
const artifact = createDeployArtifact({
  manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
  assetManifest: {},
  workerFiles: { 'index.js': btoa("export default { fetch() { return new Response('ok') } }") },
});
const ctx = createMockExecutionContext();
const basic = () => 'Basic ' + btoa(registration.client.id + ':' + registration.clientSecret);
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function request(path: string, init?: RequestInit) {
  return app.fetch(new Request(origin + path, init), env, ctx);
}
async function authorize(extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: registration.client.id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'profile',
    state,
    code_challenge: await createCodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...extra,
  });
  const response = await request('/oauth/authorize?' + params, {
    headers: { Cookie: 'void_oauth_user=' + user.jwt },
  });
  const html = await response.text();
  return {
    response,
    html,
    cookie: cookies(response) + '; void_oauth_user=' + user.jwt,
    id: html.match(/name="request" value="([^"]+)"/)?.[1],
  };
}
async function approve(id: string, cookie: string, decision = 'approve') {
  return request('/oauth/approve', {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ request: id, decision }),
  });
}
async function exchange(
  code: string,
  overrides: Record<string, string> = {},
  authorization = basic(),
) {
  return request('/oauth/token', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      ...overrides,
    }),
  });
}
async function refresh(
  refreshToken: string,
  overrides: Record<string, string> = {},
  authorization = basic(),
) {
  return request('/oauth/token', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...overrides,
    }),
  });
}
async function connect(extra: Record<string, string> = {}) {
  const flow = await authorize(extra);
  expect(flow.response.status).toBe(200);
  const consent = await approve(flow.id!, flow.cookie);
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get('Location')!);
  expect(location.searchParams.get('state')).toBe(state);
  expect(location.searchParams.has('token')).toBe(false);
  const code = location.searchParams.get('code')!;
  const token = await exchange(code);
  expect(token.status).toBe(200);
  return {
    code,
    token: (await token.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    },
  };
}
async function publishApproval(profile: string, slug: string, prepared = artifact) {
  const pending = await request('/oauth/deployment-requests', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + profile, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uri: redirect,
      state,
      code_challenge: await createCodeChallenge(verifier),
      code_challenge_method: 'S256',
      slug,
      checkpoint: 'checkpoint-123',
      artifact: prepared,
    }),
  });
  expect(pending.status).toBe(201);
  const { request_id: id } = (await pending.json()) as { request_id: string };
  const opened = await request('/oauth/authorize?request=' + id, {
    headers: { Cookie: 'void_oauth_user=' + user.jwt },
  });
  expect(opened.status).toBe(200);
  return { id, cookie: cookies(opened) + '; void_oauth_user=' + user.jwt };
}
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  env.AUTH_REDIRECT_URI = origin + '/auth/callback';
  delete env.DEV_AUTH_BYPASS;
  env.DEPLOYMENTS_QUEUE = {
    send: async (body: unknown) =>
      processDeploymentBatch(
        {
          queue: 'deployments',
          messages: [
            { body, ack() {}, retry() {}, attempts: 1, id: 'message', timestamp: new Date() },
          ],
          ackAll() {},
          retryAll() {},
        } as unknown as MessageBatch<unknown>,
        env as unknown as ApiEnv['Bindings'],
      ),
  } as unknown as Queue;
  user = await createTestUser(env.db, 'alice', 'github', '12345');
  registration = await registerOAuthClient(env.db, {
    name: 'Vibevoid',
    operator: 'App operator',
    redirectUris: [redirect],
    scopes: ['profile', 'deploy:approve'],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('registered OAuth applications', () => {
  it('signs only the assets declared by a private preview receipt', async () => {
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    const headers = {
      Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json',
    };
    const project = (await (
      await request('/oauth/previews', {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace: 'asset-preview' }),
      })
    ).json()) as { project_id: string };
    const asset = {
      blake3: computeAssetHash(new TextEncoder().encode('app').buffer, '/app.js'),
      md5: 'a'.repeat(32),
      size: 3,
      contentType: 'text/javascript',
    };
    const otherAsset = {
      ...asset,
      blake3: computeAssetHash(new TextEncoder().encode('page').buffer, '/page.js'),
      md5: 'b'.repeat(32),
      size: 4,
    };
    const prepared = createDeployArtifact({
      ...artifact,
      assetManifest: {
        '/app.js': { ...asset, hash: asset.blake3 },
        '/page.js': { ...otherAsset, hash: otherAsset.blake3 },
        '/wrong-type.js': {
          ...asset,
          blake3: 'd'.repeat(32),
          hash: 'd'.repeat(32),
          size: '3' as unknown as number,
        },
      },
    });
    const issued = await request('/oauth/preview-deployment-requests', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: project.project_id,
        checkpoint: 'head',
        artifact: prepared,
      }),
    });
    const receipt = (await issued.json()) as { access_token: string; approval_id: string };
    const upload = (...assets: Array<typeof asset>) =>
      request('/projects/' + project.project_id + '/deploy/upload-urls', {
        method: 'POST',
        headers: { ...headers, Authorization: 'Bearer ' + receipt.access_token },
        body: JSON.stringify({ assets }),
      });
    expect((await upload(asset)).status).toBe(200);
    expect((await upload(otherAsset, asset, asset)).status).toBe(200);
    expect((await upload({ ...asset, size: 4 })).status).toBe(403);
    expect((await upload({ ...asset, md5: 'b'.repeat(32) })).status).toBe(403);
    expect((await upload({ ...asset, blake3: 'c'.repeat(32) })).status).toBe(403);
    expect((await upload(otherAsset, { ...asset, size: 4 })).status).toBe(403);
    expect((await upload({ ...asset, blake3: 'd'.repeat(32) })).status).toBe(403);
    const [record] = await env.db
      .select()
      .from(oauthRequests)
      .where(eq(oauthRequests.id, receipt.approval_id));
    expect(record.data.artifact?.workerFiles).toBeUndefined();
    expect(record.data.workerModules).toEqual(['index.js']);
  });
  it('requires user consent to private previews without elevating old grants', async () => {
    const { token: old } = await connect();
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const create = (token: string, workspace = 'workspace-1') =>
      request('/oauth/previews', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      });
    expect((await create(old.access_token)).status).toBe(403);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    expect(token.scope).toBe('profile preview:deploy');
    const created = await create(token.access_token);
    expect(created.status).toBe(201);
    const preview = (await created.json()) as { project_id: string };
    expect(
      ((await (await create(token.access_token)).json()) as { project_id: string }).project_id,
    ).toBe(preview.project_id);
    const [row] = await env.db.select().from(projects).where(eq(projects.id, preview.project_id));
    expect(row.preview_client_id).toBe(registration.client.id);
    expect(row.preview_workspace_id).toBe('workspace-1');
    expect(
      (
        await request('/projects/' + row.id + '/secrets', {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + user.jwt },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    await setOAuthPreviewPermission(env.db, registration.client.id, false);
    expect((await create(token.access_token)).status).toBe(403);
  });
  it('pins preview deployment credentials to isolated projects and exact artifacts', async () => {
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    const headers = {
      Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json',
    };
    const preview = (await (
      await request('/oauth/previews', {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace: 'checkpoint-app' }),
      })
    ).json()) as { project_id: string; url: string };
    const production = await createTestProject(env.db, user.id, 'production-app');
    const credential = (id: string, prepared = artifact) =>
      request('/oauth/preview-deployment-requests', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: id, checkpoint: 'abc', artifact: prepared }),
      });
    expect((await credential(production.id)).status).toBe(404);
    expect(
      (
        await credential(
          preview.project_id,
          createDeployArtifact({
            ...artifact,
            manifest: { ...artifact.manifest, bindings: { hyperdrive: ['production'] } },
          }),
        )
      ).status,
    ).toBe(400);
    const issued = await credential(preview.project_id);
    expect(issued.status).toBe(201);
    const approval = (await issued.json()) as { access_token: string; approval_id: string };
    await expect(
      verifyOAuthDeployment(
        env.db,
        approval.approval_id,
        preview.project_id,
        approval.approval_id,
        artifact,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyOAuthDeployment(
        env.db,
        approval.approval_id,
        preview.project_id,
        approval.approval_id,
        createDeployArtifact({ ...artifact, workerFiles: { 'index.js': btoa('changed') } }),
      ),
    ).rejects.toThrow();
    const denied = await request('/projects/' + production.id + '/deploy', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + approval.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(artifact),
    });
    expect(denied.status).toBe(403);
    await request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.access_token }),
    });
    await expect(activeOAuthApproval(env.db, approval.approval_id)).rejects.toThrow();
  });
  it('exchanges one-use launch tickets, isolates origins and strips credentials before serving', async () => {
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    const headers = {
      Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json',
    };
    const preview = (await (
      await request('/oauth/previews', {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace: 'ready-app' }),
      })
    ).json()) as { project_id: string; url: string };
    await env.db
      .update(projects)
      .set({ active_deployment_id: 'ready' })
      .where(eq(projects.id, preview.project_id));
    const launch = await request('/oauth/previews/' + preview.project_id + '/launch', {
      method: 'POST',
      headers,
    });
    expect(launch.status).toBe(200);
    const { url } = (await launch.json()) as { url: string };
    let forwarded: Request | undefined;
    (env as unknown as ApiEnv['Bindings']).PREVIEW_DISPATCH = {
      fetch: async (req: Request) => {
        forwarded = req;
        return new Response('ready', {
          headers: { 'Set-Cookie': 'stolen=1', 'Content-Type': 'text/html' },
        });
      },
    } as Fetcher;
    const serve = '/oauth/preview-serve/' + preview.project_id;
    expect((await request(serve, { headers: { 'X-Void-Preview-URL': preview.url } })).status).toBe(
      401,
    );
    const opened = await request(serve, { headers: { 'X-Void-Preview-URL': url } });
    expect(opened.status).toBe(303);
    expect(opened.headers.get('Location')).toBe(preview.url + '/');
    expect((await request(serve, { headers: { 'X-Void-Preview-URL': url } })).status).toBe(401);
    const cookie = cookies(opened);
    const response = await request(serve, {
      headers: {
        Cookie: cookie,
        'X-Void-Preview-URL': preview.url + '/hello',
        Authorization: 'Bearer do-not-forward',
        'CF-Access-Client-Secret': 'private',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ready');
    expect(forwarded!.url).toBe(preview.url + '/hello');
    expect([...forwarded!.headers.keys()]).not.toContain('cookie');
    expect([...forwarded!.headers.keys()]).not.toContain('authorization');
    expect([...forwarded!.headers.keys()]).not.toContain('cf-access-client-secret');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.has('X-Frame-Options')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).not.toBe("frame-ancestors 'none'");
    expect(
      (
        await request(serve, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'X-Void-Preview-URL': preview.url,
            Origin: 'https://other-preview.example.com',
          },
          body: 'write',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(serve, {
          headers: { Cookie: cookie, 'X-Void-Preview-URL': 'https://other-preview.example.com/' },
        })
      ).status,
    ).toBe(404);
    await disableOAuthClient(env.db, registration.client.id);
    expect(
      (await request(serve, { headers: { Cookie: cookie, 'X-Void-Preview-URL': preview.url } }))
        .status,
    ).toBe(401);
    delete (env as unknown as ApiEnv['Bindings']).PREVIEW_DISPATCH;
  });
  it('deploys previews with the normal receipt and keeps their replayed routing private', async () => {
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    const headers = {
      Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json',
    };
    const preview = (await (
      await request('/oauth/previews', {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace: 'deployed-preview' }),
      })
    ).json()) as { project_id: string };
    const issued = (await (
      await request('/oauth/preview-deployment-requests', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: preview.project_id, checkpoint: 'head', artifact }),
      })
    ).json()) as { access_token: string; approval_id: string };
    mockCfApi();
    const init = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + issued.access_token,
        'Content-Type': 'application/json',
        'x-void-deploy-idempotency-key': issued.approval_id,
      },
      body: JSON.stringify({ ...artifact, source: 'connected-app', commit: 'head' }),
    };
    const deployed = await request('/projects/' + preview.project_id + '/deploy', init);
    expect(deployed.status, await deployed.clone().text()).toBe(200);
    expect(await readAllEvents(deployed)).toContainEqual(
      expect.objectContaining({ event: 'done' }),
    );
    const [project] = await env.db
      .select()
      .from(projects)
      .where(eq(projects.id, preview.project_id));
    const routing = JSON.parse((await env.ROUTING.get('preview:' + project.slug))!);
    expect(routing.privatePreview).toBe(true);
    expect(routing.projectId).toBe(preview.project_id);
    const retry = await request('/projects/' + preview.project_id + '/deploy', init);
    expect(await readAllEvents(retry)).toContainEqual(expect.objectContaining({ event: 'done' }));
    expect(JSON.parse((await env.ROUTING.get('preview:' + project.slug))!).privatePreview).toBe(
      true,
    );
  });
  it('invalidates derived grants when the upstream human session is revoked', async () => {
    await importLegacyAuthentication(env.db, env);
    const human = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: user.id,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
    });
    user.jwt = human.token;
    const { token } = await connect();
    await revokeConnectionSessions(env.db, 'github');
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + token.access_token },
        })
      ).status,
    ).toBe(401);
  });
  it('signs immutable asset uploads and rejects bytes that do not match the approved BLAKE3', async () => {
    const { token } = await connect();
    const project = await createTestProject(env.db, user.id, 'asset-app');
    const bytes = new TextEncoder().encode('approved');
    const hash = computeAssetHash(bytes.buffer, '/app.js');
    const prepared = createDeployArtifact({
      ...artifact,
      assetManifest: { '/app.js': { blake3: hash, hash, md5: 'a'.repeat(32), size: bytes.length } },
    });
    const flow = await publishApproval(token.access_token, project.slug, prepared);
    const consent = await approve(flow.id, flow.cookie);
    const { access_token: access } = (await (
      await exchange(new URL(consent.headers.get('Location')!).searchParams.get('code')!)
    ).json()) as { access_token: string };
    const headers = { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' };
    const upload = await request('/projects/' + project.id + '/deploy/upload-urls', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assets: [
          { blake3: hash, md5: 'a'.repeat(32), size: bytes.length, contentType: 'text/javascript' },
        ],
      }),
    });
    expect(upload.status).toBe(200);
    const { urls } = (await upload.json()) as {
      urls: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(urls[hash]!.headers).toMatchObject({
      'If-None-Match': '*',
      'Content-Length': String(bytes.length),
    });
    expect(new URL(urls[hash]!.url).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'if-none-match',
    );
    expect(new URL(urls[hash]!.url).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );
    const undeclared = await request('/projects/' + project.id + '/deploy/upload-urls', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assets: [
          {
            blake3: 'f'.repeat(32),
            md5: 'a'.repeat(32),
            size: bytes.length,
            contentType: 'text/javascript',
          },
        ],
      }),
    });
    expect(undeclared.status).toBe(403);
    await env.STATIC_ASSETS_R2.put('assets/' + project.id + '/' + hash, 'tampered');
    mockCfApi();
    const result = await request('/projects/' + project.id + '/deploy', {
      method: 'POST',
      headers: { ...headers, 'x-void-deploy-idempotency-key': flow.id },
      body: JSON.stringify(prepared),
    });
    expect(await readAllEvents(result)).toContainEqual(
      expect.objectContaining({ event: 'error', message: expect.stringContaining('differs') }),
    );
    await env.STATIC_ASSETS_R2.put('assets/' + project.id + '/' + hash, bytes);
    const retry = await publishApproval(token.access_token, project.slug, prepared);
    const accepted = await approve(retry.id, retry.cookie);
    const renewed = (await (
      await exchange(new URL(accepted.headers.get('Location')!).searchParams.get('code')!)
    ).json()) as { access_token: string };
    const verified = await request('/projects/' + project.id + '/deploy', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + renewed.access_token,
        'Content-Type': 'application/json',
        'x-void-deploy-idempotency-key': retry.id,
      },
      body: JSON.stringify(prepared),
    });
    expect(await readAllEvents(verified)).toContainEqual(
      expect.objectContaining({ event: 'done' }),
    );
  });
  it.each([false, true])(
    'stops publication when the administrator disables the client during a queued upload (private preview: %s)',
    async (privatePreview) => {
      if (privatePreview) {
        await setOAuthPreviewPermission(env.db, registration.client.id, true);
      }
      const { token } = await connect(privatePreview ? { scope: 'profile preview:deploy' } : {});
      let projectId: string;
      let approvalId: string;
      let access: string;
      if (privatePreview) {
        const headers = {
          Authorization: 'Bearer ' + token.access_token,
          'Content-Type': 'application/json',
        };
        const created = await request('/oauth/previews', {
          method: 'POST',
          headers,
          body: JSON.stringify({ workspace: 'revoked-preview' }),
        });
        projectId = ((await created.json()) as { project_id: string }).project_id;
        const issued = await request('/oauth/preview-deployment-requests', {
          method: 'POST',
          headers,
          body: JSON.stringify({ project_id: projectId, checkpoint: 'abc', artifact }),
        });
        const receipt = (await issued.json()) as { access_token: string; approval_id: string };
        access = receipt.access_token;
        approvalId = receipt.approval_id;
      } else {
        const project = await createTestProject(env.db, user.id, 'revoked-app');
        projectId = project.id;
        const flow = await publishApproval(token.access_token, project.slug);
        const consent = await approve(flow.id, flow.cookie);
        access = (
          (await (
            await exchange(new URL(consent.headers.get('Location')!).searchParams.get('code')!)
          ).json()) as { access_token: string }
        ).access_token;
        approvalId = flow.id;
      }
      mockCfApi({
        uploadWorker: async () => {
          await disableOAuthClient(env.db, registration.client.id);
          return new Response('ok');
        },
      });
      const result = await request('/projects/' + projectId + '/deploy', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + access,
          'Content-Type': 'application/json',
          'x-void-deploy-idempotency-key': approvalId,
        },
        body: JSON.stringify(artifact),
      });
      const events = await readAllEvents(result);
      expect(events.some((event) => (event as { event: string }).event === 'done')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ event: 'error' }));
      const [project] = await env.db.select().from(projects).where(eq(projects.id, projectId));
      expect(project.active_deployment_id).toBeNull();
    },
  );
  it('keeps connected-app Worker modules inside the approved artifact', async () => {
    const { token } = await connect();
    const project = await createTestProject(env.db, user.id, 'static-approved-app');
    // A static artifact: its approval digest commits to no Worker modules.
    const prepared = createDeployArtifact({ manifest: artifact.manifest, assetManifest: {} });
    const flow = await publishApproval(token.access_token, project.slug, prepared);
    const consent = await approve(flow.id, flow.cookie);
    const { access_token: access } = (await (
      await exchange(new URL(consent.headers.get('Location')!).searchParams.get('code')!)
    ).json()) as { access_token: string };
    const headers = { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' };
    const module = { name: 'index.js', size: 18, sha256: 'a'.repeat(64) };
    const urls = await request('/projects/' + project.id + '/deploy/worker-upload-urls', {
      method: 'POST',
      headers,
      body: JSON.stringify({ modules: [module] }),
    });
    expect(urls.status).toBe(403);
    const cf = mockCfApi();
    const deploy = await request('/projects/' + project.id + '/deploy', {
      method: 'POST',
      headers: { ...headers, 'x-void-deploy-idempotency-key': flow.id },
      body: JSON.stringify({
        ...prepared,
        workerInput: { id: crypto.randomUUID(), modules: [module] },
      }),
    });
    expect(deploy.status).toBe(403);
    expect(await deploy.json()).toMatchObject({ message: expect.stringContaining('workerFiles') });
    expect(cf).not.toHaveBeenCalled();
  });
  it('registers and disables clients through the administrator UI with an audit trail', async () => {
    const admin = await createTestUser(env.db, 'administrator', 'github', 'admin', 'free', 'admin');
    const input = new URLSearchParams({
      name: 'Registered app',
      operator: 'Provider',
      redirectUris: redirect,
      publish: 'true',
    });
    const headers = {
      Origin: origin,
      Cookie: 'admin_token=' + admin.adminJwt,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-VoidPages': 'true',
    };
    expect(
      (
        await request('/admin/connected-apps', {
          method: 'POST',
          headers: { ...headers, Cookie: 'admin_token=' + user.adminJwt },
          body: input,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await request('/admin/connected-apps', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example.com' },
          body: input,
        })
      ).status,
    ).toBe(403);
    const response = await request('/admin/connected-apps', {
      method: 'POST',
      headers,
      body: input,
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      props: { credentials: { clientId: string; clientSecret: string } };
    };
    const { clientId, clientSecret } = page.props.credentials;
    const [stored] = await env.db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
    expect(stored!.secret_hash).not.toBe(clientSecret);
    const listed = await request('/admin/connected-apps', { headers });
    expect(await listed.text()).not.toContain(clientSecret);
    expect(
      (await request('/admin/connected-apps/' + clientId + '/disable', { method: 'POST', headers }))
        .status,
    ).toBe(302);
    const events = await env.db
      .select()
      .from(operatorEvents)
      .where(eq(operatorEvents.user_id, admin.id));
    expect(events.map((event) => event.status)).toEqual(['success', 'success']);
    expect(JSON.stringify(events)).not.toContain(clientSecret);
  });
  it('keeps the account-token login bridge on Void’s own domain', async () => {
    const params = new URLSearchParams({
      client_id: registration.client.id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'profile',
      state,
      code_challenge: await createCodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const started = await request('/oauth/authorize?' + params);
    const html = await started.text();
    const requestId = html.match(/\/oauth\/login\?request=([^&"]+)/)![1]!;
    const proof = cookies(started);
    const bridge = await request('/oauth/login?request=' + requestId + '&provider=github', {
      headers: { Cookie: proof },
    });
    const login = await app.fetch(
      new Request(bridge.headers.get('Location')!, { headers: { Cookie: proof } }),
      env,
      ctx,
    );
    expect(login.status).toBe(302);
    const provider = new URL(login.headers.get('Location')!);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('github.com/login/oauth/access_token')) {
          return Response.json({ access_token: 'github-test-token' });
        }
        if (url.endsWith('/user/emails')) {
          return Response.json([{ email: 'alice@example.com', primary: true, verified: true }]);
        }
        if (url.endsWith('/user')) {
          return Response.json({ id: 12345, login: 'alice', email: null });
        }
        throw new Error('Unexpected provider URL');
      }),
    );
    const callback = await request(
      '/auth/callback?code=github-code&state=' +
        encodeURIComponent(provider.searchParams.get('state')!),
      { headers: { Cookie: proof + '; ' + cookies(login) } },
    );
    expect(callback.status, await callback.clone().text()).toBe(302);
    const target = new URL(callback.headers.get('Location')!);
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe('/oauth/login/callback');
    expect(target.searchParams.has('token')).toBe(false);
    const signedIn = await app.fetch(new Request(target, { headers: { Cookie: proof } }), env, ctx);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('Set-Cookie')).toContain('void_oauth_user=');
    expect(signedIn.headers.get('Set-Cookie')).toContain('HttpOnly');
    const consent = await request('/oauth/authorize?request=' + requestId, {
      headers: { Cookie: proof + '; ' + cookies(signedIn) },
    });
    expect(await consent.text()).toContain('Connect application');
  });
  it('returns only identity and rejects the grant on account and administrator APIs', async () => {
    const { token } = await connect();
    expect(token.scope).toBe('profile');
    expect(token.expires_in).toBeLessThanOrEqual(3600);
    const identity = await request('/oauth/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    expect(await identity.json()).toEqual({
      sub: user.id,
      preferred_username: 'alice',
      scope: 'profile',
    });
    for (const path of ['/me', '/projects', '/admin/projects']) {
      const response = await request(path, {
        headers: { Authorization: 'Bearer ' + token.access_token },
      });
      expect(response.status).not.toBe(200);
    }
    env.DEV_AUTH_BYPASS = 'true';
    expect(
      (await request('/projects', { headers: { Authorization: 'Bearer ' + token.access_token } }))
        .status,
    ).toBe(401);
  });
  it('requires exact redirects, S256, state, and permitted scopes', async () => {
    const invalid: Array<Record<string, string>> = [
      { redirect_uri: redirect + '?host=evil' },
      { scope: 'deploy:approve' },
      { state: 'short' },
      { code_challenge_method: 'plain' },
      { redirect_uri: 'https://evil.example.com/auth/callback' },
    ];
    for (const extra of invalid) {
      expect((await authorize(extra)).response.status).toBe(400);
    }
  });
  it('authenticates the client and checks PKCE before consuming a single-use code', async () => {
    const flow = await authorize();
    const consent = await approve(flow.id!, flow.cookie);
    const code = new URL(consent.headers.get('Location')!).searchParams.get('code')!;
    expect(
      (await exchange(code, {}, 'Basic ' + btoa(registration.client.id + ':wrong'))).status,
    ).toBe(401);
    expect((await exchange(code, { code_verifier: 'x'.repeat(64) })).status).toBe(400);
    expect((await exchange(code, { redirect_uri: redirect + '/' })).status).toBe(400);
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
  });
  it('requires the browser proof and Void origin for consent and honors cancellation', async () => {
    const flow = await authorize();
    expect((await approve(flow.id!, 'void_oauth_user=' + user.jwt)).status).toBe(403);
    const csrf = await request('/oauth/approve', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example.com',
        Cookie: flow.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ request: flow.id!, decision: 'approve' }),
    });
    expect(csrf.status).toBe(403);
    const denied = await approve(flow.id!, flow.cookie, 'deny');
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(await env.db.select().from(oauthGrants)).toHaveLength(0);
  });
  it('revokes grants on disconnect, client disablement, and account suspension', async () => {
    const first = await connect();
    const revoked = await request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: first.token.access_token }),
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + first.token.access_token },
        })
      ).status,
    ).toBe(401);
    const second = await connect();
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, user.id));
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + second.token.access_token },
        })
      ).status,
    ).toBe(401);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, user.id));
    const pending = await authorize();
    await disableOAuthClient(env.db, registration.client.id);
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + second.token.access_token },
        })
      ).status,
    ).toBe(401);
    expect((await approve(pending.id!, pending.cookie)).status).not.toBe(302);
  });
  it('mints a refresh token on connect, rotates it on use, and invalidates the prior access token', async () => {
    const { token } = await connect();
    expect(token.refresh_token).toBeTruthy();
    const refreshed = await refresh(token.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    };
    expect(next.access_token).not.toBe(token.access_token);
    expect(next.refresh_token).not.toBe(token.refresh_token);
    expect(next.scope).toBe('profile');
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + token.access_token },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + next.access_token },
        })
      ).status,
    ).toBe(200);
  });
  it('detects refresh token reuse and revokes the whole grant', async () => {
    const { token } = await connect();
    const first = await refresh(token.refresh_token);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { access_token: string; refresh_token: string };
    // Replaying the already-rotated refresh token is treated as theft.
    const replay = await refresh(token.refresh_token);
    expect(replay.status).toBe(400);
    expect((await replay.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
    // The entire grant family is now revoked, including the token issued by the first refresh.
    const second = await refresh(firstBody.refresh_token);
    expect(second.status).toBe(401);
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + firstBody.access_token },
        })
      ).status,
    ).toBe(401);
  });
  it('rejects an unknown or garbage refresh token', async () => {
    expect((await refresh('not-a-real-refresh-token')).status).toBe(400);
  });
  it('enforces an absolute refresh lifetime that rotation cannot extend', async () => {
    const { token } = await connect();
    const [row] = await env.db.select().from(oauthRefreshTokens);
    expect(row).toBeTruthy();
    await env.db
      .update(oauthRefreshTokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthRefreshTokens.id, row!.id));
    expect((await refresh(token.refresh_token)).status).toBe(400);
  });
  it('narrows scope on refresh and does not let a later refresh widen it back', async () => {
    await setOAuthPreviewPermission(env.db, registration.client.id, true);
    const { token } = await connect({ scope: 'profile preview:deploy' });
    expect(token.scope).toBe('profile preview:deploy');
    const narrowed = await refresh(token.refresh_token, { scope: 'profile' });
    expect(narrowed.status).toBe(200);
    const narrowedBody = (await narrowed.json()) as { refresh_token: string; scope: string };
    expect(narrowedBody.scope).toBe('profile');
    const widenAttempt = await refresh(narrowedBody.refresh_token, {
      scope: 'profile preview:deploy',
    });
    expect(widenAttempt.status).toBe(400);
    const [grant] = await env.db.select().from(oauthGrants);
    expect(grant!.scopes).toEqual(['profile']);
  });
  it('rejects a refresh token presented to a different client', async () => {
    const { token } = await connect();
    const other = await registerOAuthClient(env.db, {
      name: 'Other app',
      operator: 'Other operator',
      redirectUris: [redirect],
      scopes: ['profile'],
    });
    const otherBasic = 'Basic ' + btoa(other.client.id + ':' + other.clientSecret);
    expect((await refresh(token.refresh_token, {}, otherBasic)).status).toBe(400);
  });
  it('blocks refresh once the grant is revoked, client disabled, account suspended, or the session is invalidated', async () => {
    const disconnected = await connect();
    await request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: disconnected.token.access_token }),
    });
    expect((await refresh(disconnected.token.refresh_token)).status).toBe(401);

    const suspended = await connect();
    await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, user.id));
    expect((await refresh(suspended.token.refresh_token)).status).toBe(401);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, user.id));

    const disabled = await connect();
    await disableOAuthClient(env.db, registration.client.id);
    expect((await refresh(disabled.token.refresh_token)).status).toBe(401);
    registration = await registerOAuthClient(env.db, {
      name: 'Vibevoid',
      operator: 'App operator',
      redirectUris: [redirect],
      scopes: ['profile', 'deploy:approve'],
    });

    await importLegacyAuthentication(env.db, env);
    const human = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: user.id,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
    });
    user.jwt = human.token;
    const bySession = await connect();
    await revokeConnectionSessions(env.db, 'github');
    expect((await refresh(bySession.token.refresh_token)).status).toBe(401);
  });
  it('revokes a refresh token (and its grant) through the revocation endpoint', async () => {
    const { token } = await connect();
    const revoked = await request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.refresh_token }),
    });
    expect(revoked.status).toBe(200);
    expect((await refresh(token.refresh_token)).status).toBe(401);
    expect(
      (
        await request('/oauth/userinfo', {
          headers: { Authorization: 'Bearer ' + token.access_token },
        })
      ).status,
    ).toBe(401);
  });
  it('never issues a refresh token for a publish (deploy:approve) credential', async () => {
    const { token } = await connect();
    const project = await createTestProject(env.db, user.id, 'no-refresh-app');
    const flow = await publishApproval(token.access_token, project.slug);
    const consent = await approve(flow.id, flow.cookie);
    const code = new URL(consent.headers.get('Location')!).searchParams.get('code')!;
    const exchanged = await exchange(code, {}, basic());
    expect(exchanged.status).toBe(200);
    const body = (await exchanged.json()) as { scope: string; refresh_token?: string };
    expect(body.scope).toBe('deploy:approve');
    expect(body.refresh_token).toBeUndefined();
  });
  it('advertises the refresh_token grant in authorization server metadata', async () => {
    const metadata = await request('/.well-known/oauth-authorization-server');
    const body = (await metadata.json()) as { grant_types_supported: Array<string> };
    expect(body.grant_types_supported).toContain('refresh_token');
  });
  it('requires approval by the grant owner and limits a publish to the chosen artifact and project', async () => {
    const { token } = await connect();
    const project = await createTestProject(env.db, user.id, 'approved-app');
    const flow = await publishApproval(token.access_token, project.slug);
    const bob = await createTestUser(env.db, 'bob');
    expect((await approve(flow.id, flow.cookie.replace(user.jwt, bob.jwt))).status).toBe(403);
    const consent = await approve(flow.id, flow.cookie);
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get('Location')!).searchParams.get('code')!;
    const response = await exchange(code);
    expect(response.status, await response.clone().text()).toBe(200);
    const deployment = (await response.json()) as {
      access_token: string;
      project_id: string;
      approval_id: string;
    };
    expect(deployment.project_id).toBe(project.id);
    expect(deployment.approval_id).toBe(flow.id);
    const headers = { Authorization: 'Bearer ' + deployment.access_token };
    for (const path of [
      '/projects',
      '/projects/' + project.id + '/secrets',
      '/projects/' + project.id + '/tokens',
      '/projects/other',
    ]) {
      expect((await request(path, { headers })).status).toBe(403);
    }
    await expect(
      verifyOAuthDeployment(
        env.db,
        flow.id,
        project.id,
        flow.id,
        artifact as unknown as Record<string, unknown>,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyOAuthDeployment(
        env.db,
        flow.id,
        project.id,
        'different',
        artifact as unknown as Record<string, unknown>,
      ),
    ).rejects.toThrow('one deployment');
    await expect(
      verifyOAuthDeployment(env.db, flow.id, project.id, flow.id, {
        ...artifact,
        workerFiles: { 'index.js': btoa('different worker') },
      }),
    ).rejects.toThrow('differs');
    const mismatch = await request('/projects/' + project.id + '/deploy', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'x-void-deploy-idempotency-key': flow.id,
      },
      body: JSON.stringify({ ...artifact, workerFiles: { 'index.js': btoa('changed') } }),
    });
    expect(mismatch.status).toBe(403);
    await disableOAuthClient(env.db, registration.client.id);
    await expect(activeOAuthApproval(env.db, flow.id)).rejects.toThrow();
    expect((await request('/projects/' + project.id, { headers })).status).toBe(401);
  });
  it('deploys the approved artifact and preserves its receipt on a retry', async () => {
    const { token } = await connect();
    const project = await createTestProject(env.db, user.id, 'published-app');
    const flow = await publishApproval(token.access_token, project.slug);
    const consent = await approve(flow.id, flow.cookie);
    const code = new URL(consent.headers.get('Location')!).searchParams.get('code')!;
    const { access_token: access } = (await (await exchange(code)).json()) as {
      access_token: string;
    };
    mockCfApi();
    const init = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + access,
        'Content-Type': 'application/json',
        'x-void-deploy-idempotency-key': flow.id,
      },
      body: JSON.stringify({ ...artifact, source: 'connected-app', commit: 'checkpoint-123' }),
    };
    const response = await request('/projects/' + project.id + '/deploy', init);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await readAllEvents(response)).toContainEqual(
      expect.objectContaining({ event: 'done' }),
    );
    const retry = await request('/projects/' + project.id + '/deploy', init);
    expect(retry.status).toBe(200);
    expect(await readAllEvents(retry)).toContainEqual(expect.objectContaining({ event: 'done' }));
    const rows = await env.db.select().from(oauthRequests).where(eq(oauthRequests.id, flow.id));
    expect(rows[0]?.consumed_at).toBeTruthy();
  });
});
