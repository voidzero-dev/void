import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vite-plus/test';
import { getDeployment, getProject } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { replayDeploymentCutover } from '../../src/deploy/recovery.ts';
import { settleExpiredDeployment } from '../../src/deployment-recovery.ts';
import type { ApiEnv } from '../../src/env.ts';
import { sandboxControllerWorkerName } from '../../src/provisioning/sandbox-controller.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
import { deployments, domains, projectMigrations, projects, resources } from '../../src/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  cfSuccess,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let project: Awaited<ReturnType<typeof createTestProject>>;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const owner = await createTestUser(env.db, 'recovery-owner');
  project = await createTestProject(env.db, owner.id, 'recovery-project');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function settle(deploymentId: string) {
  return settleExpiredDeployment(env as unknown as ApiEnv['Bindings'], env.db, deploymentId);
}

function providerDelete(status = 200) {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('confirms candidate cleanup before failing interrupted preparation, preserving committed app and SQL', async () => {
  const committed = await createTestDeployment(env.db, project.id);
  const candidate = await createTestDeployment(env.db, project.id, 'migrating');
  await env.db.insert(resources).values({
    id: 'resource-recovery',
    project_id: project.id,
    type: 'd1',
    cf_id: 'existing-database',
    binding_name: 'DB',
  });
  await env.db.insert(projectMigrations).values({
    project_id: project.id,
    name: '0001_created_table',
    source_deployment_id: candidate.id,
  });
  await env.ROUTING.put(project.slug, JSON.stringify({ workerName: 'committed-worker' }));
  await env.ROUTING.put(`manifest:${candidate.id}`, '{}');
  await env.STATIC_ASSETS_R2.put(`assets/${project.id}/shared-asset`, 'preserve');
  await env.STATIC_ASSETS_R2.put(
    `worker-bundles/${project.id}/${candidate.id}/index.js`,
    'candidate',
  );
  await env.db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(eq(deployments.id, candidate.id));
  const fetch = providerDelete();

  expect(await settle(candidate.id)).toMatchObject({
    terminal: true,
    event: { event: 'error', step: 'recovery', message: expect.stringContaining('interrupted') },
  });
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({
    status: 'failed',
    bundle_stored: false,
  });
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(committed.id);
  expect(await env.ROUTING.get(project.slug, 'json')).toEqual({ workerName: 'committed-worker' });
  expect(await env.ROUTING.get(`manifest:${candidate.id}`)).toBeNull();
  expect(
    await env.STATIC_ASSETS_R2.head(`worker-bundles/${project.id}/${candidate.id}/index.js`),
  ).toBeNull();
  expect(await env.STATIC_ASSETS_R2.head(`assets/${project.id}/shared-asset`)).not.toBeNull();
  expect(await env.db.select().from(resources)).toHaveLength(1);
  expect(await env.db.select().from(projectMigrations)).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toContain(`scripts/user-${project.slug}-${candidate.id}`);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
});

test('keeps cancellation and candidate artifacts when provider deletion is unconfirmed, then recovers on retry', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  await env.ROUTING.put(`manifest:${candidate.id}`, '{}');
  providerDelete(503);
  await expect(settle(candidate.id)).rejects.toThrow('cleanup failed');
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'canceling' });
  expect(await env.ROUTING.get(`manifest:${candidate.id}`)).toBe('{}');

  providerDelete(404);
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'failed' });
});

test('removes the candidate service binding before its sandbox controller, preserving both on an unconfirmed Worker delete', async () => {
  const committed = await createTestDeployment(env.db, project.id);
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  const workerName = `user-${project.slug}-${candidate.id}`;
  const controllerName = sandboxControllerWorkerName(project.id, candidate.id);
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ type: 'worker', sandbox: { runtime: { protocol: 2 } } }),
    })
    .where(eq(deployments.id, candidate.id));
  let rejectWorkerDelete = true;
  const cf = mockCfApi({
    deleteWorker: (url) => {
      const name = new URL(url).pathname.split('/').at(-1)!;
      if (name === workerName && rejectWorkerDelete) {
        return new Response(null, { status: 503 });
      }
      if (name === controllerName && cf.state.hostScripts.has(workerName)) {
        return Response.json(
          { errors: [{ message: 'Controller is still referenced by candidate service binding' }] },
          { status: 400 },
        );
      }
      cf.state.hostScripts.delete(name);
      return new Response(null, { status: 200 });
    },
  });
  cf.state.hostScripts.set(workerName, {
    classes: new Map(),
    metadata: {},
    bindings: [{ type: 'service', name: '__VOID_SANDBOX', service: controllerName }],
  });
  cf.state.hostScripts.set(controllerName, {
    classes: new Map(),
    metadata: {},
    bindings: [
      {
        type: 'plain_text',
        name: '__VOID_SANDBOX_OWNER',
        text: JSON.stringify({ protocol: 1, projectId: project.id, deploymentId: candidate.id }),
      },
      {
        type: 'plain_text',
        name: '__VOID_USER_ID',
        text: (await getProject(env.db, project.id))!.user_id,
      },
      {
        type: 'durable_object_namespace',
        name: 'SANDBOX',
        class_name: 'SandboxController',
        namespace_id: 'candidate-controller',
      },
    ],
  });

  await expect(settle(candidate.id)).rejects.toThrow('cleanup failed');
  expect(cf.state.hostScripts.has(workerName)).toBe(true);
  expect(cf.state.hostScripts.has(controllerName)).toBe(true);
  expect((await getDeployment(env.db, candidate.id))?.status).toBe('canceling');

  rejectWorkerDelete = false;
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(cf.state.hostScripts.has(workerName)).toBe(false);
  expect(cf.state.hostScripts.has(controllerName)).toBe(false);
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(committed.id);
  expect((await getDeployment(env.db, candidate.id))?.status).toBe('failed');
});

test('preserves an explicit user cancellation after confirmed cleanup', async () => {
  const candidate = await createTestDeployment(
    env.db,
    project.id,
    'canceling',
    undefined,
    'canceled by user',
  );
  providerDelete(404);
  expect(await settle(candidate.id)).toMatchObject({
    terminal: true,
    event: { event: 'error', message: 'canceled by user' },
  });
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'canceled' });
});

test('preserves an already acknowledged canceled status during cleanup retry', async () => {
  const candidate = await createTestDeployment(
    env.db,
    project.id,
    'canceled',
    undefined,
    'canceled by user',
  );
  providerDelete(404);
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'canceled' });
});

test('reconciles a lost cleanup commit acknowledgement without another deployment or SQL execution', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  const realTransaction = env.db.transaction.bind(env.db);
  let injected = false;
  const wrappedDb = new Proxy(env.db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (callback: Parameters<Db['transaction']>[0]) => {
          const result = await realTransaction(callback);
          if (!injected && (await getDeployment(env.db, candidate.id))?.status === 'failed') {
            injected = true;
            throw new Error('cleanup COMMIT acknowledgement lost');
          }
          return result;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const fetch = providerDelete(404);
  await expect(
    settleExpiredDeployment(env as unknown as ApiEnv['Bindings'], wrappedDb, candidate.id),
  ).rejects.toThrow('COMMIT');
  expect(injected).toBe(true);
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'failed' });
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(await env.db.select().from(deployments)).toHaveLength(1);
  expect(fetch.mock.calls.every(([, init]) => init?.method === 'DELETE')).toBe(true);
});

test('reports a committed live deployment after a lost result without deleting it', async () => {
  const live = await createTestDeployment(env.db, project.id);
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ version: 3, type: 'spa', bindings: {} }),
      asset_hashes: JSON.stringify({ '/index.html': { hash: 'a'.repeat(32), size: 10 } }),
    })
    .where(eq(deployments.id, live.id));
  await env.db.insert(domains).values({
    id: 'domain-recovery',
    project_id: project.id,
    hostname: 'recovered.example.com',
    cf_hostname_id: 'hostname-recovery',
    status: 'active',
  });
  const fetch = providerDelete();
  expect(await settle(live.id)).toMatchObject({
    terminal: true,
    event: {
      event: 'done',
      deployment: live.id,
      url: 'https://recovered.example.com',
      urls: ['https://recovered.example.com', `https://${project.slug}.void.app`],
      assets: 1,
      workers: 0,
    },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(await getDeployment(env.db, live.id)).toMatchObject({ status: 'live' });
});

test('compensates an expired protected cutover immediately to committed static code', async () => {
  const committed = await createTestDeployment(env.db, project.id);
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
    })
    .where(eq(deployments.id, committed.id));
  await env.db.update(projects).set({ type: 'static' }).where(eq(projects.id, project.id));
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  await env.db
    .update(deployments)
    .set({ status: 'cutover' })
    .where(eq(deployments.id, candidate.id));
  await env.ROUTING.put(
    `cutover-intent:${candidate.id}`,
    JSON.stringify({
      projectId: project.id,
      ownerId: 'expired-owner',
      buildId: null,
    }),
  );
  await env.ROUTING.put(project.slug, JSON.stringify({ deploymentId: candidate.id }));
  providerDelete();

  expect(await settle(candidate.id)).toMatchObject({ terminal: true, event: { event: 'error' } });
  expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
    staticDeploymentId: committed.id,
  });
  expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(committed.id);
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'failed' });
});

test('retains the protected fence when compensation fails, then retries from durable state', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  await env.db
    .update(deployments)
    .set({ status: 'cutover' })
    .where(eq(deployments.id, candidate.id));
  const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
  vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
    if (key === project.slug) {
      throw new Error('routing unavailable');
    }
    return originalDelete(key);
  });
  const fetch = providerDelete();
  expect(await settle(candidate.id)).toEqual({ terminal: false });
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'compensating' });
  expect(fetch).not.toHaveBeenCalled();

  vi.restoreAllMocks();
  providerDelete();
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
});

test('settles static preparation without dispatch provider access', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ version: 3, type: 'spa', bindings: {} }),
    })
    .where(eq(deployments.id, candidate.id));
  const fetch = providerDelete(403);
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(await getDeployment(env.db, candidate.id)).toMatchObject({ status: 'failed' });
});

test('does not clean up a nonterminal candidate referenced by the committed active pointer', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'uploading');
  await env.db
    .update(projects)
    .set({ active_deployment_id: candidate.id })
    .where(eq(projects.id, project.id));
  const fetch = providerDelete();
  expect(await settle(candidate.id)).toEqual({ terminal: false });
  expect(fetch).not.toHaveBeenCalled();
});

test('preserves retained historical deployment artifacts while terminalizing its journal', async () => {
  const candidate = await createTestDeployment(env.db, project.id, 'failed');
  await env.db.update(deployments).set({ retained: true }).where(eq(deployments.id, candidate.id));
  await env.ROUTING.put(`manifest:${candidate.id}`, '{}');
  const fetch = providerDelete();
  expect(await settle(candidate.id)).toMatchObject({ terminal: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(await env.ROUTING.get(`manifest:${candidate.id}`)).toBe('{}');
});

test.each([
  { issued: 1, held: 0, maxConcurrency: 2 },
  { issued: 1, held: 1, maxConcurrency: 1 },
  { issued: 0, held: 0, maxConcurrency: undefined },
])(
  'cutover replay to a Worker on generation $held while generation $issued is issued writes only its token',
  async ({ issued, held, maxConcurrency }) => {
    await env.db
      .update(projects)
      .set({ proxy_token_gen: issued })
      .where(eq(projects.id, project.id));
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 3,
          type: 'void',
          bindings: {},
          schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS', maxConcurrency }],
        }),
      })
      .where(eq(deployments.id, deployment.id));
    await env.db.insert(resources).values({
      id: 'resource-replay-queue',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });
    const heldToken = await deriveProxyToken(env.JWT_SECRET, project.id, held);
    const consumerBodies: Array<unknown> = [];
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: heldToken }]),
      addQueueConsumer: (_url, init) => {
        consumerBodies.push(JSON.parse(String(init?.body)));
        return cfSuccess({ consumer_id: 'consumer-1' });
      },
    });
    const syncBodies: Array<string> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/sync') {
            syncBodies.push(await request.text());
          }
          return new Response('{}', { status: 200 });
        },
      };
    });

    const lockedProject = (await getProject(env.db, project.id))!;
    await replayDeploymentCutover(
      env as unknown as ApiEnv['Bindings'],
      env.db,
      lockedProject,
      (await getDeployment(env.db, deployment.id))!,
      lockedProject.type,
      { restoreCommitted: true },
    );

    expect(
      await env.ROUTING.get(`queue:${project.id.replaceAll('_', '-')}-emails`, 'json'),
    ).toEqual({
      workerName: `user-${project.slug}-${deployment.id}`,
      projectId: project.id,
      queueName: 'emails',
      proxyToken: heldToken,
    });
    expect(syncBodies).toHaveLength(1);
    const sync = JSON.parse(syncBodies[0]) as Record<string, unknown>;
    // Exactly one token: the one the Worker holds.
    expect(Object.keys(sync).filter((key) => key.startsWith('proxyToken'))).toEqual(['proxyToken']);
    expect(sync.proxyToken).toBe(heldToken);
    expect(consumerBodies).toEqual([
      {
        script_name: 'void-dispatch',
        type: 'worker',
        settings: maxConcurrency === undefined ? {} : { max_concurrency: maxConcurrency },
      },
    ]);
  },
);
