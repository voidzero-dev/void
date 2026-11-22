import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vite-plus/test';
import { getProject, getProjectResources } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { FAST_MAINTENANCE_KEY } from '../../src/fast-maintenance.ts';
import { app } from '../../src/index.ts';
import { getProjectQueueName } from '../../src/naming.ts';
import { settleDeploymentForSandboxDrain } from '../../src/routes/deploy.ts';
import { deployments, operatorEvents, projects, resources } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;
let owner: Awaited<ReturnType<typeof createTestUser>>;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  owner = await createTestUser(env.db, 'operator', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, owner);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(projectId: string, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/projects/${projectId}/normalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}
async function legacyProject() {
  const project = await createTestProject(env.db, owner.id);
  const older = await createTestDeployment(env.db, project.id);
  const newer = await createTestDeployment(env.db, project.id);
  await env.db
    .update(projects)
    .set({ active_deployment_id: null })
    .where(eq(projects.id, project.id));
  const route = JSON.stringify({
    projectId: project.id,
    staticDeploymentId: older.id,
    version: older.id,
  });
  await env.ROUTING.put(project.slug, route);
  return { project, older, newer, route };
}

test('previews without writing, records the older serving rollback target, audits, and repeats as a no-op', async () => {
  const { project, older, route } = await legacyProject();
  const put = vi.spyOn(env.ROUTING, 'put');
  const del = vi.spyOn(env.ROUTING, 'delete');
  const preview = await req(project.id, { dryRun: true });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { changes: unknown };
  expect(body).toMatchObject({
    dryRun: true,
    changes: { activeDeployment: { from: null, to: older.id }, queues: [] },
  });
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
  const applied = await req(project.id, { expected: body.changes });
  expect(applied.status).toBe(200);
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(older.id);
  const repeated = await req(project.id, { dryRun: true });
  const repeatBody = (await repeated.json()) as { changes: unknown };
  expect(repeatBody).toMatchObject({
    changes: { activeDeployment: { from: older.id, to: older.id }, queues: [] },
  });
  expect((await req(project.id, { expected: repeatBody.changes })).status).toBe(200);
  expect(await env.ROUTING.get(project.slug)).toBe(route);
  // The request itself arms the fast maintenance tier; no project key is written.
  expect(put.mock.calls.map(([key]) => key)).toEqual([FAST_MAINTENANCE_KEY]);
  expect(del).not.toHaveBeenCalled();
  expect(await env.db.select().from(operatorEvents)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: `projects/${project.id}/normalize`,
        target: JSON.stringify({ projectId: project.id }),
      }),
    ]),
  );
});

test.each(['missing', 'conflicting', 'foreign', 'nonlive', 'unversioned'])(
  'rejects %s routing without guessing from history',
  async (kind) => {
    const { project, older, newer } = await legacyProject();
    const route =
      kind === 'missing'
        ? null
        : kind === 'conflicting'
          ? { projectId: project.id, staticDeploymentId: older.id, version: newer.id }
          : kind === 'foreign'
            ? { projectId: 'foreign', version: older.id }
            : kind === 'unversioned'
              ? { version: older.id, workerName: `user-${project.slug}` }
              : {
                  projectId: project.id,
                  version: (await createTestDeployment(env.db, project.id, 'pending')).id,
                };
    if (route) {
      await env.ROUTING.put(project.slug, JSON.stringify(route));
    } else {
      await env.ROUTING.delete(project.slug);
    }
    if (kind === 'nonlive') {
      await env.db
        .update(deployments)
        .set({ status: 'failed' })
        .where(eq(deployments.project_id, project.id));
      // Keep genuine live history, but point routing at the failed row.
      await env.db.update(deployments).set({ status: 'live' }).where(eq(deployments.id, older.id));
    }
    const response = await req(project.id, { dryRun: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'normalization_unverified' });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
  },
);

test('keeps a valid existing pointer even when routing names a different historical deployment', async () => {
  const { project, older, newer } = await legacyProject();
  await env.db
    .update(projects)
    .set({ active_deployment_id: newer.id })
    .where(eq(projects.id, project.id));
  const response = await req(project.id, { dryRun: true });
  expect(await response.json()).toMatchObject({
    changes: { activeDeployment: { from: newer.id, to: newer.id } },
  });
  expect(newer.id).not.toBe(older.id);
});

test('preserves an owned authoritative pointer to a retained failed rollback target', async () => {
  const { project, newer } = await legacyProject();
  await env.db
    .update(deployments)
    .set({ status: 'failed', retained: true })
    .where(eq(deployments.id, newer.id));
  await env.db
    .update(projects)
    .set({ active_deployment_id: newer.id })
    .where(eq(projects.id, project.id));
  const response = await req(project.id, { dryRun: true });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { changes: unknown };
  expect(body).toMatchObject({ changes: { activeDeployment: { from: newer.id, to: newer.id } } });
  expect((await req(project.id, { expected: body.changes })).status).toBe(200);
  const [target] = await env.db.select().from(deployments).where(eq(deployments.id, newer.id));
  expect(target.status).toBe('failed');
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(newer.id);
});

test.each(['missing', 'foreign'])(
  'rejects an existing pointer to a %s deployment',
  async (kind) => {
    const project = await createTestProject(env.db, owner.id);
    const foreign = await createTestProject(env.db, owner.id);
    const other = await createTestDeployment(env.db, foreign.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: kind === 'missing' ? 'dpl_missing' : other.id })
      .where(eq(projects.id, project.id));
    const response = await req(project.id, { dryRun: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'normalization_unverified' });
  },
);

test.each(['pending', 'cutover', 'rollback-lease', 'deleting'])(
  'rejects busy project state %s before reading provider resources',
  async (kind) => {
    const project = await createTestProject(env.db, owner.id);
    if (kind === 'deleting') {
      await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    } else {
      const deployment = await createTestDeployment(
        env.db,
        project.id,
        'pending',
        kind === 'rollback-lease' ? kind : undefined,
      );
      if (kind === 'cutover') {
        await env.db
          .update(deployments)
          .set({ status: 'cutover' })
          .where(eq(deployments.id, deployment.id));
      }
    }
    const provider = vi.spyOn(globalThis, 'fetch');
    expect((await req(project.id, { dryRun: true })).status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
  },
);

test('resolves the recorded queue name exactly and performs only database writes', async () => {
  const project = await createTestProject(env.db, owner.id);
  const recordedName = getProjectQueueName(project.id, 'emails');
  const queueId = '1234567890abcdef1234567890abcdef';
  await env.db.insert(resources).values({
    id: 'res_old_queue',
    project_id: project.id,
    type: 'queue',
    binding_name: 'emails',
    cf_id: recordedName,
  });
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ success: true, result: [{ queue_name: recordedName, queue_id: queueId }] }),
    );
  const preview = await req(project.id, { dryRun: true });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { changes: unknown };
  expect((await getProjectResources(env.db, project.id))[0].cf_id).toBe(recordedName);
  expect((await req(project.id, { expected: body.changes })).status).toBe(200);
  expect((await getProjectResources(env.db, project.id))[0].cf_id).toBe(queueId);
  expect(provider).toHaveBeenCalledTimes(2);
  for (const call of provider.mock.calls) {
    expect(String(call[0])).toContain(`/queues?name=${recordedName}`);
    expect(call[1]?.method ?? 'GET').toBe('GET');
  }
});

test('verifies a differently named queue exactly but refuses identity repair until its delivery routing is reconciled', async () => {
  const project = await createTestProject(env.db, owner.id);
  const recordedName = 'older-installation-queue-name';
  await env.db.insert(resources).values({
    id: 'res_differently_named',
    project_id: project.id,
    type: 'queue',
    binding_name: 'emails',
    cf_id: recordedName,
  });
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      success: true,
      result: [{ queue_name: recordedName, queue_id: 'a'.repeat(32) }],
    }),
  );
  const response = await req(project.id, { dryRun: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'queue_routing_requires_reconciliation' });
  expect(String(provider.mock.calls[0][0])).toContain(`/queues?name=${recordedName}`);
  expect((await getProjectResources(env.db, project.id))[0].cf_id).toBe(recordedName);
});

test.each(['different-name', 'invalid-id'])(
  'rejects an unverified queue response: %s',
  async (kind) => {
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(resources).values({
      id: 'res_queue_bad',
      project_id: project.id,
      type: 'queue',
      binding_name: 'emails',
      cf_id: 'recorded-name',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        success: true,
        result: [
          {
            queue_name: kind === 'different-name' ? 'foreign-name' : 'recorded-name',
            queue_id: kind === 'invalid-id' ? 'not-an-id' : 'a'.repeat(32),
          },
        ],
      }),
    );
    expect((await req(project.id, { dryRun: true })).status).toBe(409);
    expect((await getProjectResources(env.db, project.id))[0].cf_id).toBe('recorded-name');
  },
);

test.each(['a'.repeat(32), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'])(
  'accepts provider ID %s without a name lookup',
  async (id) => {
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(resources).values({
      id: 'res_valid_queue',
      project_id: project.id,
      type: 'queue',
      binding_name: 'emails',
      cf_id: id,
    });
    const provider = vi.spyOn(globalThis, 'fetch');
    const response = await req(project.id, { dryRun: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changes: { queues: [] } });
    expect(provider).not.toHaveBeenCalled();
  },
);

test('rejects changed preview and never guesses during protected recovery', async () => {
  const { project, older, newer } = await legacyProject();
  const preview = await req(project.id, { dryRun: true });
  const body = (await preview.json()) as { changes: unknown };
  await env.ROUTING.put(
    project.slug,
    JSON.stringify({ projectId: project.id, version: newer.id, staticDeploymentId: newer.id }),
  );
  expect((await req(project.id, { expected: body.changes })).status).toBe(409);
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
  const interrupted = await createTestDeployment(env.db, project.id, 'pending');
  await env.db
    .update(deployments)
    .set({ status: 'compensating', updated_at: '2020-01-01T00:00:00Z' })
    .where(eq(deployments.id, interrupted.id));
  const intent = JSON.stringify({
    projectId: project.id,
    ownerId: 'original-fence',
    buildId: null,
  });
  await env.ROUTING.put(`cutover-intent:${interrupted.id}`, intent);
  const route = await env.ROUTING.get(project.slug);
  expect(
    await settleDeploymentForSandboxDrain(
      env as unknown as ApiEnv['Bindings'],
      env.db,
      interrupted.id,
    ),
  ).toMatchObject({
    state: 'recovery_incomplete',
  });
  expect(await env.ROUTING.get(`cutover-intent:${interrupted.id}`)).toBe(intent);
  expect(await env.ROUTING.get(project.slug)).toBe(route);
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
  expect(older.id).not.toBe(newer.id);
});

test.each(['deploy', 'deploy/preflight', 'deploy/upload-urls', 'rollback'])(
  'blocks ordinary %s mutation when a serving pointer needs normalization',
  async (path) => {
    const { project, older, route } = await legacyProject();
    await env.db.update(deployments).set({ retained: true }).where(eq(deployments.id, older.id));
    const provider = vi.spyOn(globalThis, 'fetch');
    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: older.id }),
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'project_requires_normalization' });
    expect(provider).not.toHaveBeenCalled();
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
    expect(await env.ROUTING.get(project.slug)).toBe(route);
  },
);

test('preserves the rollback lease owner when a missing pointer prevents recovery', async () => {
  const { project, older, route } = await legacyProject();
  const lease = await createTestDeployment(env.db, project.id, 'pending', 'rollback-lease');
  const manifest = JSON.stringify({
    targetDeploymentId: older.id,
    ownerId: 'original-lease-owner',
    state: 'running',
  });
  await env.db
    .update(deployments)
    .set({ manifest, updated_at: '2020-01-01T00:00:00Z' })
    .where(eq(deployments.id, lease.id));
  expect(
    await settleDeploymentForSandboxDrain(env as unknown as ApiEnv['Bindings'], env.db, lease.id),
  ).toMatchObject({ state: 'recovery_incomplete' });
  const [row] = await env.db.select().from(deployments).where(eq(deployments.id, lease.id));
  expect(row.manifest).toBe(manifest);
  expect(row.status).toBe('pending');
  expect(await env.ROUTING.get(project.slug)).toBe(route);
});
