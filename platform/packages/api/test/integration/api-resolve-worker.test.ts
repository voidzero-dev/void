import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { setActiveDeployment } from '../../src/db.ts';
import app from '../../src/index.ts';
import { deriveProxyInternalAuth } from '../../src/proxy-token.ts';
import { projects } from '../../src/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

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

async function resolveWorker(projectId: string): Promise<Response> {
  const auth = await deriveProxyInternalAuth(env.JWT_SECRET, 'resolve-worker', projectId);
  return app.fetch(
    new Request(`http://localhost/internal/resolve-worker/${projectId}`, {
      method: 'POST',
      headers: { 'x-void-proxy-internal': auth },
    }),
    env,
  );
}

describe('POST /internal/resolve-worker/:projectId', () => {
  it('follows the active deployment pointer across a rollback', async () => {
    const user = await createTestUser(env.db, 'resolve-worker-rollback');
    const project = await createTestProject(env.db, user.id, 'rollback-app');
    const rollbackTarget = await createTestDeployment(env.db, project.id, 'live');
    const newer = await createTestDeployment(env.db, project.id, 'live');

    const current = await resolveWorker(project.id);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      workerName: `user-${project.slug}-${newer.id}`,
      deploymentId: newer.id,
      proxyTokenGen: 0,
    });

    await setActiveDeployment(env.db, project.id, rollbackTarget.id);
    const rolledBack = await resolveWorker(project.id);
    expect(rolledBack.status).toBe(200);
    expect(await rolledBack.json()).toEqual({
      workerName: `user-${project.slug}-${rollbackTarget.id}`,
      deploymentId: rollbackTarget.id,
      proxyTokenGen: 0,
    });
  });

  it('reports a static active deployment without inventing a worker', async () => {
    const user = await createTestUser(env.db, 'resolve-worker-static');
    const project = await createTestProject(env.db, user.id, 'static-app');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db.update(projects).set({ type: 'static' }).where(eq(projects.id, project.id));

    const response = await resolveWorker(project.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'active deployment has no worker',
      deploymentId: deployment.id,
    });
  });

  it('rejects an active deployment pointer owned by another project', async () => {
    const user = await createTestUser(env.db, 'resolve-worker-owner');
    const project = await createTestProject(env.db, user.id, 'owner-app');
    const otherProject = await createTestProject(env.db, user.id, 'other-app');
    const otherDeployment = await createTestDeployment(env.db, otherProject.id, 'live');
    await setActiveDeployment(env.db, project.id, otherDeployment.id);

    const response = await resolveWorker(project.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'active deployment not found' });
  });
});
