import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { deployments } from '../../src/schema.ts';
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

const disabledCapabilities = JSON.stringify({
  ai: true,
  customDomains: true,
  email: true,
  githubActions: true,
  githubOAuth: true,
  googleOAuth: true,
  managedBuilds: true,
  sandbox: false,
});

describe('managed Sandbox capability disablement', () => {
  it('rejects a new Sandbox deployment when the installation disables it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sandbox-disabled');
    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            sandbox: {
              controllerProtocol: 2,
              bindingName: 'SANDBOX',
              className: 'Sandbox',
              containerName: 'void-sandbox',
              image:
                'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] }],
            },
          },
          assetManifest: {},
          workerFiles: {},
        }),
      }),
      { ...env, PLATFORM_CAPABILITIES: disabledCapabilities },
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      event: 'error',
      message: 'This Void platform does not enable sandbox deployments.',
    });
  });

  it('rejects rollback to a retained Sandbox deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sandbox-rollback-disabled');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({
          version: 3,
          bindings: {},
          sandbox: {
            bindingName: 'SANDBOX',
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image:
              'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: deployment.id }),
      }),
      { ...env, PLATFORM_CAPABILITIES: disabledCapabilities },
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: 'This Void platform does not enable rollback to Sandbox deployments.',
    });
  });
});
