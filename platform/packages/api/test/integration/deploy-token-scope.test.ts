import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { signJwt } from '../../src/auth/jwt.ts';
import { createDeployment } from '../../src/db.ts';
import * as db from '../../src/db.ts';
import app from '../../src/index.ts';
import { builds, deployments } from '../../src/schema.ts';
import {
  createTestBuild,
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // builds reference projects via FK, so they must be cleared before
  // clearTables() deletes projects (clearTables does not touch builds).
  await env.db.delete(builds);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A scoped (aud:'deploy') token authenticates as the project owner but is
// minted only to run `void deploy` against ONE project. The authMiddleware
// allowlist must let the deploy flow's own endpoints through while denying
// every other owner-scoped /projects/* route (delete, secrets PUT, github
// connect, ...) and any cross-project use.
describe('deploy token scope enforcement', () => {
  // Without an explicit build, bind the token to a fresh active build of the
  // scoped project, as remote builds do.
  async function deployToken(
    projectId: string,
    userId: string,
    login = 'octocat',
    buildId?: string,
  ): Promise<string> {
    const boundBuildId =
      buildId ??
      (
        await createTestBuild(env.db, {
          projectId,
          userId,
          executor: 'github_actions',
          status: 'building',
        })
      ).id;
    return signDeployToken({ projectId, userId, login, buildId: boundBuildId }, env.JWT_SECRET);
  }

  it('lets the real deploy endpoint through (auth passes; not 403)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-app');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    // Empty body — the handler will 400 (or some other non-403), but the point
    // is that the auth middleware did NOT reject it with 403 forbidden.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      env,
    );

    expect(res.status).not.toBe(403);
  });

  it('lets a deploy token request Worker module upload URLs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-worker-upload');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/worker-upload-urls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modules: [{ name: 'index.js', size: 18, sha256: 'a'.repeat(64) }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: expect.any(String), urls: [expect.any(Object)] });
  });

  it('lets the deploy sibling endpoints through (preflight, upload-urls)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-siblings');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const preflight = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(preflight.status).not.toBe(403);

    const uploadUrls = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(uploadUrls.status).not.toBe(403);
  });

  it('lets the deploy read endpoints through (resources, deployments, secrets list)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-reads');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    for (const path of ['resources', 'deployments', 'secrets']) {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      );
      // GET /projects/:id/{resources,deployments,secrets} must reach the
      // handler (owner check passes), not be 403'd by the deploy-token gate.
      expect(res.status).not.toBe(403);
    }
  });

  // The deployments endpoint is on the deploy-token allowlist, but the deploy
  // manifest's `vars` field carries plaintext env values (uploaded as plain_text
  // Worker bindings). A leaked/untrusted build token must not be able to read
  // historical env values through it. The CLI only needs `manifest.live` for
  // live-binding restoration, so that field is preserved.
  it('strips manifest.vars (plaintext env) for deploy-token callers but keeps manifest.live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-stripped');
    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      vars: { SECRET: 'super-secret-value', API_KEY: 'k-123' },
      live: {
        bindingName: 'LIVE',
        className: 'LiveObject',
        storage: 'sqlite',
        classes: ['LiveObject'],
      },
    });
    await createDeployment(env.db, project.id, manifest);
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(1);
    const returned = JSON.parse(body.deployments[0].manifest!) as Record<string, unknown>;
    // The plaintext env values must be gone...
    expect(returned.vars).toBeUndefined();
    expect('vars' in returned).toBe(false);
    // ...but the live-binding restoration metadata must survive for the CLI.
    expect(returned.live).toEqual({
      bindingName: 'LIVE',
      className: 'LiveObject',
      storage: 'sqlite',
      classes: ['LiveObject'],
    });
    // Non-secret structural fields are untouched.
    expect(returned.version).toBe(3);
  });

  it('returns the FULL manifest (including vars) for a full api token', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-full');
    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      vars: { SECRET: 'super-secret-value' },
      live: {
        bindingName: 'LIVE',
        className: 'LiveObject',
        storage: 'sqlite',
        classes: ['LiveObject'],
      },
    });
    await createDeployment(env.db, project.id, manifest);
    mockCfApi();

    // A normal aud:'api' token (deployScope unset) keeps the full manifest.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(1);
    const returned = JSON.parse(body.deployments[0].manifest!) as Record<string, unknown>;
    expect(returned.vars).toEqual({ SECRET: 'super-secret-value' });
  });

  it('returns manifest:null for deploy-token callers when the manifest is unparseable', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-vars-garbage');
    // A null manifest and a non-JSON garbage manifest must both fail safe to
    // null (never returning an unparseable string that might carry secrets).
    await createDeployment(env.db, project.id, null);
    await createDeployment(env.db, project.id, 'not-json-at-all{');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: ReadonlyArray<{ manifest: string | null }>;
    };
    expect(body.deployments).toHaveLength(2);
    for (const deployment of body.deployments) {
      expect(deployment.manifest).toBeNull();
    }
  });

  it('lets listProjects through (slug→id resolution)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deploy-list');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).not.toBe(403);
  });

  it('listProjects with a P-scoped deploy token returns ONLY P (no cross-project metadata)', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'scoped-listed');
    const projectQ = await createTestProject(env.db, user.id, 'sibling-hidden');
    // Token scoped to P only; Q belongs to the same owner.
    const token = await deployToken(projectP.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadonlyArray<{ id: string; slug: string }>;
    const ids = body.map((p) => p.id);
    // The scoped project must be present so the CLI can resolve slug→id...
    expect(ids).toContain(projectP.id);
    // ...but the sibling must NOT leak through.
    expect(ids).not.toContain(projectQ.id);
    expect(ids).toHaveLength(1);
  });

  it('listProjects with a full api token returns ALL owner projects', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'api-listed-p');
    const projectQ = await createTestProject(env.db, user.id, 'api-listed-q');
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadonlyArray<{ id: string; slug: string }>;
    const ids = body.map((p) => p.id);
    // A full `api` token (deployScope unset) keeps the complete listing.
    expect(ids).toContain(projectP.id);
    expect(ids).toContain(projectQ.id);
  });

  it('rejects DELETE /projects/:id (project takeover)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'delete-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/credential.*assigned project.*sign in with your account/i),
    });
  });

  it('rejects PUT /projects/:id/secrets/:name (secret rewrite)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/FOO`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'pwned' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/credential.*assigned project.*sign in with your account/i),
    });
  });

  it('rejects POST /projects/:id/github (repoint GitHub connection)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'github-target');
    const token = await deployToken(project.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: 1, repoFullName: 'evil/repo' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/credential.*assigned project.*sign in with your account/i),
    });
  });

  it('rejects a P-scoped token used against a different project (cross-project)', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'scoped-project');
    const projectOther = await createTestProject(env.db, user.id, 'other-project');
    // Token scoped to projectP, used against projectOther's deploy endpoint.
    const token = await deployToken(projectP.id, user.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectOther.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/credential.*assigned project.*sign in with your account/i),
    });
  });

  // A deploy token may be bound to the build it was minted for. Once that build
  // is no longer active (superseded/cancelled by a newer push or run), a stale
  // runner that still holds the token must be rejected at deploy time — the DB
  // supersede is only advisory until the deploy endpoint enforces it.
  it('rejects a deploy token whose bound build is cancelled (superseded runner)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-cancelled');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('lets a deploy token whose bound build is still active (building) through the build guard', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-active');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    // Empty body — the handler 400s on manifest validation, but the point is
    // that the build-state guard did NOT reject it with 403.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).not.toBe(403);
  });

  // A deploy token must be bound to a build or a CI credential. One with
  // neither would skip both the build-state and the revocation checks.
  it('rejects a deploy token with neither a build nor a credential claim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-unbound');
    const token = await signJwt(
      { sub: user.id, login: user.login, aud: 'deploy', project: project.id },
      env.JWT_SECRET,
      { ttlSeconds: 15 * 60 },
    );
    mockCfApi();

    const requests = [
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ];
    for (const request of requests) {
      const res = await app.fetch(request, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid or expired token',
        message: 'This deploy credential is invalid. Ask the project owner to issue a replacement.',
      });
    }
    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeUndefined();
  });

  // The build-state guard lives in authMiddleware, so it gates EVERY allowlisted
  // route a deploy token may hit — not just POST /deploy. These mutating
  // endpoints (database provisioning, asset preflight, presigned upload URLs)
  // must reject a token whose bound build is no longer active, otherwise a
  // superseded/cancelled runner could still mutate real project state.
  const ALLOWLISTED_MUTATING_ROUTES: ReadonlyArray<{ name: string; path: string }> = [
    { name: 'POST /projects/:id/database', path: 'database' },
    { name: 'POST /projects/:id/deploy/preflight', path: 'deploy/preflight' },
    { name: 'POST /projects/:id/deploy/upload-urls', path: 'deploy/upload-urls' },
    { name: 'POST /projects/:id/deploy/worker-upload-urls', path: 'deploy/worker-upload-urls' },
  ];

  for (const status of ['cancelled', 'failed'] as const) {
    for (const route of ALLOWLISTED_MUTATING_ROUTES) {
      it(`rejects a deploy token bound to a ${status} build on ${route.name}`, async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, `build-${status}-${route.path}`);
        const build = await createTestBuild(env.db, {
          projectId: project.id,
          userId: user.id,
          executor: 'github_actions',
          status,
        });
        const token = await deployToken(project.id, user.id, 'octocat', build.id);
        mockCfApi();

        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/${route.path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          }),
          env,
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: 'deploy token build is no longer active',
          message: expect.stringMatching(/start a new build/i),
        });
      });
    }
  }

  for (const route of ALLOWLISTED_MUTATING_ROUTES) {
    it(`lets a deploy token bound to an active (building) build through to ${route.name}`, async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `build-active-${route.path}`);
      const build = await createTestBuild(env.db, {
        projectId: project.id,
        userId: user.id,
        executor: 'github_actions',
        status: 'building',
      });
      const token = await deployToken(project.id, user.id, 'octocat', build.id);
      mockCfApi();

      // Empty body — the handler will return some non-403 (400/etc.), but the
      // point is that the central build-state guard did NOT reject it with 403.
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/${route.path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
        }),
        env,
      );
      expect(res.status).not.toBe(403);
    });
  }

  // The build claim must belong to the token's scoped project. A token whose
  // bound build references a DIFFERENT project is rejected even when that build
  // is active — defends against a build-id/project-scope mismatch.
  it('rejects a deploy token whose bound build belongs to a different project', async () => {
    const user = await createTestUser(env.db);
    const projectP = await createTestProject(env.db, user.id, 'build-scope-self');
    const projectOther = await createTestProject(env.db, user.id, 'build-scope-other');
    // Active build, but it belongs to projectOther, while the token is scoped to projectP.
    const build = await createTestBuild(env.db, {
      projectId: projectOther.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(projectP.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectP.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  // A complete JSON-mode (direct-to-R2) deploy request that exercises the WfP
  // pipeline all the way to the final publish transaction. No assets and a
  // trivial default worker module, so `mockCfApi()` covers every CF call.
  function fullDeployRequest(projectId: string, token: string): Request {
    return new Request(`http://localhost/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
        assetManifest: {},
        workerFiles: {
          // base64 of a trivial worker module.
          'index.js': btoa("export default { fetch() { return new Response('ok'); } }"),
        },
      }),
    });
  }

  // The up-front build guard in `handleManifestOnlyDeploy` checks the bound
  // build ONCE at request entry. The request then spends
  // minutes parsing, prechecking, provisioning, and uploading. During that
  // window a newer GitHub Actions run can supersede (cancel) the OLD bound
  // build. Without a re-check inside the final publish transaction a superseded
  // runner would still flip the deployment to `live` with stale code.
  //
  // This test proves the FINAL-tx re-check fires (not just the up-front guard):
  // the build is `building` at request entry (so the up-front guard PASSES),
  // and the mid-flight cancel is injected during the Cloudflare Worker upload.
  // The final-tx row-locked re-check then observes the terminal build and
  // aborts the publish.
  it('rejects a deploy whose bound build is cancelled mid-flight (final-tx re-check)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-superseded-midflight');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building', // ACTIVE at the up-front guard
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    let cancelInjected = false;
    mockCfApi({
      uploadWorker: async () => {
        // Supersede the build after its request-entry guard, before final publish.
        await env.db
          .update(builds)
          .set({ status: 'cancelled', error: 'superseded by newer run' })
          .where(eq(builds.id, build.id));
        cancelInjected = true;
        return cfSuccess({ id: 'uploaded-worker' });
      },
    });

    const res = await app.fetch(fullDeployRequest(project.id, token), env);
    expect(res.status).toBe(200); // streaming NDJSON response

    const events = await readAllEvents(res);
    expect(cancelInjected).toBe(true); // confirm the seam fired before publish
    // The publish was aborted — an error event, never a `done`.
    expect(events.some((e) => (e as { event: string }).event === 'done')).toBe(false);
    const errEvent = events.find((e) => (e as { event: string }).event === 'error') as
      | { event: string; message?: string }
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toBe('bound build was superseded');

    // The deployment row must NOT be live. Routing is rolled back and the row
    // is marked terminal by the post-routing rollback branch.
    const liveRows = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.status, 'live'));
    expect(liveRows).toHaveLength(0);

    // The project must not point at any deployment (publish tx rolled back).
    const updatedProject = await db.getProject(env.db, project.id);
    expect(updatedProject?.active_deployment_id ?? null).toBeNull();
  });

  // Control: a bound build that stays ACTIVE through the entire pipeline
  // (up-front guard AND final-tx re-check) deploys normally and goes live.
  it('lets a deploy go live when the bound build stays active through the final tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'build-active-through');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await deployToken(project.id, user.id, 'octocat', build.id);
    mockCfApi();

    const res = await app.fetch(fullDeployRequest(project.id, token), env);
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const done = events.find((e) => (e as { event: string }).event === 'done') as
      | { event: string; deployment: string }
      | undefined;
    expect(done).toBeDefined();

    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, done!.deployment));
    expect(dpl?.status).toBe('live');
  });
});
