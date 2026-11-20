import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { computeAssetHash } from '../../src/assets.ts';
import { getDeployment } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { settleDeploymentForSandboxDrain } from '../../src/routes/deploy.ts';
import {
  deployments,
  platformSettings,
  projects,
  projectZeroTrust,
  securityPublicRequests,
} from '../../src/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  readAllEvents,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';
import { askPublic, gateBindings, setupGate } from './security-gate-fixtures.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STATIC_MANIFEST = JSON.stringify({
  version: 3,
  type: 'static',
  bindings: {},
  assetConfig: { not_found_handling: '404-page' },
});

/** A ready installation whose project protection is still being applied. */
async function seedReconcilingProtection(projectId: string): Promise<void> {
  await env.db.insert(platformSettings).values({
    key: 'zeroTrust.configuration',
    value: {
      version: 1,
      revision: 1,
      enabled: true,
      protectNewProjects: true,
      accountId: env.CF_ACCOUNT_ID,
      teamDomain: 'https://company.cloudflareaccess.com',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
      wildcardApplicationName: 'void-test-projects',
      wildcardApplication: {
        id: 'access-wildcard',
        name: 'void-test-projects',
        audience: 'access-audience',
        destinations: ['*.void.app'],
      },
      operation: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    },
  });
  await env.db.insert(projectZeroTrust).values({
    project_id: projectId,
    desired_protected: true,
    effective_protected: false,
    status: 'reconciling',
  });
}

async function retainedStaticDeployment(projectId: string, status: 'live' | 'pending' = 'live') {
  const deployment = await createTestDeployment(env.db, projectId, status);
  await env.db
    .update(deployments)
    .set({ retained: true, manifest: STATIC_MANIFEST })
    .where(eq(deployments.id, deployment.id));
  return deployment;
}

describe('Zero Trust deploy admission and recovery', () => {
  it('rejects a deploy before any provider work while protection is reconciling', async () => {
    const owner = await createTestUser(env.db, 'admission-owner');
    const project = await createTestProject(env.db, owner.id, 'admission-project');
    await seedReconcilingProtection(project.id);
    const fetch = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const bytes = new TextEncoder().encode('protected deployment');
    const hash = computeAssetHash(bytes.buffer, '/index.html');

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: JSON.parse(STATIC_MANIFEST),
          assetManifest: { '/index.html': { blake3: hash, md5: hash, size: bytes.length } },
        }),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      event: 'error',
      error: 'zero trust not ready',
      message: expect.stringContaining('void project zero-trust reconcile'),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.db.select().from(deployments).where(eq(deployments.project_id, project.id)),
    ).toEqual([]);
  });

  it('explains a rollback blocked by reconciling protection', async () => {
    const owner = await createTestUser(env.db, 'rollback-owner');
    const project = await createTestProject(env.db, owner.id, 'rollback-project');
    const target = await retainedStaticDeployment(project.id);
    const active = await retainedStaticDeployment(project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: active.id, type: 'static' })
      .where(eq(projects.id, project.id));
    await seedReconcilingProtection(project.id);

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'zero trust not ready',
      message: expect.stringContaining('void project zero-trust reconcile'),
    });
  });

  it('restores committed code for a stuck cutover while protection is reconciling', async () => {
    const owner = await createTestUser(env.db, 'recovery-owner');
    const project = await createTestProject(env.db, owner.id, 'recovery-project');
    const committed = await retainedStaticDeployment(project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: committed.id, type: 'static' })
      .where(eq(projects.id, project.id));
    const abandoned = await retainedStaticDeployment(project.id, 'pending');
    await env.db
      .update(deployments)
      .set({ status: 'cutover', updated_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(deployments.id, abandoned.id));
    await env.ROUTING.put(
      `cutover-intent:${abandoned.id}`,
      JSON.stringify({ projectId: project.id, ownerId: 'dead-owner', buildId: null }),
    );
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ projectId: project.id, deploymentId: abandoned.id }),
    );
    await seedReconcilingProtection(project.id);

    await expect(
      settleDeploymentForSandboxDrain(env as unknown as ApiEnv['Bindings'], env.db, abandoned.id),
    ).resolves.toEqual({
      state: 'terminal',
    });

    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'failed' });
    // Committed code is restored, and the unsettled protection denies access.
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      staticDeploymentId: committed.id,
      zeroTrust: { teamDomain: '', audiences: [] },
    });
  });
});

describe('deploys and rollbacks while a public request is open', () => {
  async function openRequest(s: Awaited<ReturnType<typeof setupGate>>) {
    const asked = await askPublic(s);
    expect(asked.held).toBe(true);
    const [request] = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.project_id, s.project.id));
    return request!;
  }

  it('keeps admitting deploys while the request waits, and the request follows the new live deployment', async () => {
    const s = await setupGate(env);
    const before = await openRequest(s);
    mockCfApi();
    const bytes = new TextEncoder().encode('held deploy');
    const hash = computeAssetHash(bytes.buffer as ArrayBuffer, '/index.html');
    await env.STATIC_ASSETS_R2.put(
      `assets/${s.project.id}/${hash}`,
      bytes as unknown as ArrayBuffer,
    );

    const response = await app.fetch(
      new Request(`http://localhost/projects/${s.project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { ...JSON.parse(STATIC_MANIFEST), assetManifestVersion: 2 },
          assetManifest: { '/index.html': { blake3: hash, md5: hash, size: bytes.length } },
        }),
      }),
      gateBindings(env),
    );

    expect(response.status).toBe(200);
    const events = (await readAllEvents(response)) as Array<{ event: string; deployment?: string }>;
    const done = events.find((event) => event.event === 'done');
    expect(done?.deployment).toBeDefined();
    const [after] = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.project_id, s.project.id));
    expect(['needs_deploy', 'waiting_scan']).toContain(after!.state);
    expect(after!.id).toBe(before.id);
    expect(after!.target_deployment_id).toBe(done!.deployment);
    expect((await env.db.select().from(projectZeroTrust))[0]).toMatchObject({
      desired_protected: true,
      effective_protected: true,
    });
  });

  it('a rollback moves the open request to the restored deployment', async () => {
    const s = await setupGate(env);
    const target = await retainedStaticDeployment(s.project.id);
    const active = await retainedStaticDeployment(s.project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: active.id, type: 'static' })
      .where(eq(projects.id, s.project.id));
    const before = await openRequest(s);
    expect(before.target_deployment_id).toBe(active.id);

    const response = await app.fetch(
      new Request(`http://localhost/projects/${s.project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      gateBindings(env),
    );

    expect(response.status).toBe(200);
    const [after] = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.project_id, s.project.id));
    expect(after!.id).toBe(before.id);
    expect(after!.target_deployment_id).toBe(target.id);
    expect(after!.revision).toBeGreaterThan(before.revision);
    expect(['needs_deploy', 'waiting_scan']).toContain(after!.state);
  });
});
