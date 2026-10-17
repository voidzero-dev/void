import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
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
import { getDeployment, getProjectResources } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import {
  durableObjectWorkerName,
  deleteManagedDurableObject,
} from '../../src/provisioning/durable-objects.ts';
import {
  advanceProxyTokenRotation,
  requestProxyTokenRotation,
} from '../../src/proxy-token-rotation.ts';
import { projects } from '../../src/schema.ts';
import type { DeployManifest } from '../../src/types.ts';
import {
  cfSuccess,
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  readAllEvents,
  setupEnv,
  skipOrphanSweepDelay,
  teardownEnv,
  type TestEnv,
  type MockCfApiHandle,
} from './helpers.ts';

let env: TestEnv;
let user: Awaited<ReturnType<typeof createTestUser>>;
let project: Awaited<ReturnType<typeof createTestProject>>;
let provider: MockCfApiHandle;
let failPublication = false;
const runtimeFetch = globalThis.fetch;
const writes: Array<{
  name: string;
  metadata: Record<string, unknown>;
  modules: Record<string, string>;
}> = [];
const binding = {
  bindingName: 'WORKSPACE',
  className: 'WorkspaceDurableObject',
  storage: 'sqlite' as const,
};

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  user = await createTestUser(env.db, 'durable-owner', 'github', undefined, 'solo');
  project = await createTestProject(env.db, user.id);
  failPublication = false;
  writes.length = 0;
  provider = mockCfApi();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.cloudflare.com/')) {
      return runtimeFetch(input, init);
    }
    const name = /\/scripts\/([^/?]+)/.exec(url)?.[1];
    if (
      name?.startsWith('void-do-') &&
      (url.endsWith('/bindings') || url.endsWith('/settings')) &&
      !provider.state.hostScripts.has(name)
    ) {
      if (url.endsWith('/bindings')) {
        return cfSuccess([]);
      }
      return Response.json(
        { success: false, errors: [{ code: 10007, message: 'script not found' }] },
        { status: 404 },
      );
    }
    if (name?.startsWith('void-do-') && url.endsWith('/settings') && !init?.method) {
      return cfSuccess({ bindings: provider.state.hostScripts.get(name)!.bindings });
    }
    const response = await original(input, init);
    if (init?.method === 'PUT' && init.body instanceof FormData && response.ok && name) {
      const metadata = JSON.parse(await (init.body.get('metadata') as Blob).text()) as Record<
        string,
        unknown
      >;
      const modules: Record<string, string> = {};
      for (const [part, value] of init.body) {
        if (part !== 'metadata' && value instanceof Blob) {
          modules[part] = await value.text();
        }
      }
      writes.push({ name, metadata, modules });
      // Simulate a write committed by Cloudflare whose acknowledgement is lost.
      if (
        failPublication &&
        name.startsWith('void-do-') &&
        JSON.stringify(metadata).includes('__VOID_DURABLE_DEPLOYMENT') &&
        JSON.stringify(metadata).includes('dpl_')
      ) {
        failPublication = false;
        throw new Error('connection lost after Durable Object publication');
      }
      return cfSuccess({});
    }
    if (init?.method === 'DELETE' && name?.startsWith('void-do-') && response.ok) {
      return cfSuccess(null);
    }
    return response;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function deploy(
  code = 'one',
  customBindings = [binding],
  extra: Partial<DeployManifest> = {},
  assetManifest: Record<string, { blake3: string; md5: string; size: number }> = {},
) {
  const manifest: DeployManifest = {
    version: customBindings.length ? 4 : 3,
    assetManifestVersion: 2,
    bindings: {},
    type: 'void',
    compatibilityDate: '2026-10-01',
    ...(customBindings.length ? { durableObjects: { bindings: customBindings } } : {}),
    ...extra,
  };
  const increment = code === 'two' ? 2 : 1;
  const source = `import { DurableObject } from 'cloudflare:workers';
    ${customBindings
      .map(
        ({ className }) => `export class ${className} extends DurableObject {
      async increment() { const next = (await this.ctx.storage.get('count') ?? 0) + ${increment}; await this.ctx.storage.put('count', next); return next; }
    }`,
      )
      .join('\n')}
    export default {async fetch(request,env){ return Response.json({code: ${JSON.stringify(code)}, value: await env.WORKSPACE.getByName('workspace').increment()}); }};`;
  const response = await app.fetch(
    new Request(`http://localhost/projects/${project.id}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest,
        assetManifest,
        workerFiles: { 'index.js': btoa(source) },
      }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const events = (await readAllEvents(response)) as Array<{
    event: string;
    message?: string;
    deployment?: string;
  }>;
  const done = events.find((event) => event.event === 'done');
  return { response, events, id: done?.deployment };
}

async function stored(id: string): Promise<DeployManifest> {
  return JSON.parse((await getDeployment(env.db, id))!.manifest!) as DeployManifest;
}
async function rollback(id: string) {
  return app.fetch(
    new Request(`http://localhost/projects/${project.id}/rollback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentId: id }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}
function currentRelease(worker: string) {
  return provider.state.hostScripts
    .get(worker)
    ?.bindings.find((value) => value.name === '__VOID_DURABLE_DEPLOYMENT')?.text;
}

describe('managed native Durable Objects', () => {
  it.each(['before', 'after'])(
    'recovers an R2 failure %s writing a release module',
    async (phase) => {
      const put = env.STATIC_ASSETS_R2.put.bind(env.STATIC_ASSETS_R2);
      let failed = false;
      vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async (key, value, options) => {
        if (!failed && key.includes('/durable/modules/')) {
          failed = true;
          if (phase === 'after') {
            await put(key, value, options);
          }
          throw new Error('put: internal error (10001)');
        }
        return put(key, value, options);
      });
      const result = await deploy();
      expect(failed).toBe(true);
      expect(result.id).toBeDefined();
      expect((await getDeployment(env.db, result.id!))?.status).toBe('live');
    },
  );

  it('refuses to replace an existing Worker whose bindings are empty', async () => {
    const worker = await durableObjectWorkerName(project.id, binding.className);
    provider.state.hostScripts.set(worker, {
      classes: new Map(),
      bindings: [],
      metadata: {},
    });
    const result = await deploy();
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: 'error', message: expect.stringContaining('ownership') }),
    );
    expect(writes).toHaveLength(0);
    expect(provider.state.hostScripts.get(worker)!.bindings).toEqual([]);
  });

  it('runs the published class through real RPC and retains data after upgrade, rollback, and restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-managed-native-'));
    let runtime: Miniflare | undefined;
    const worker = await durableObjectWorkerName(project.id, binding.className);
    const start = async (id: string) => {
      await runtime?.dispose();
      const native = writes.filter((write) => write.name === worker).at(-1)!;
      const application = writes.find((write) => write.name === `user-${project.slug}-${id}`)!;
      const namespaceId = (await stored(id)).durableObjects!.runtime!.namespaces
        .WorkspaceDurableObject;
      const object = {
        className: binding.className,
        scriptName: worker,
        useSQLite: true,
        unsafeUniqueKey: namespaceId,
      };
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          resourcePersistencePath: join(directory, 'state'),
          workers: [
            {
              name: 'application',
              modulesRoot: join(directory, 'application'),
              compatibilityDate: '2026-10-01',
              modules: [
                {
                  type: 'ESModule',
                  path: join(directory, 'application/index.js'),
                  contents: application.modules['index.js']!,
                },
              ],
              durableObjects: { WORKSPACE: object },
            },
            {
              name: worker,
              modulesRoot: join(directory, worker),
              compatibilityDate: '2026-10-01',
              modules: Object.entries(native.modules)
                .sort(([a], [b]) =>
                  a === '__void_durable_entry.js'
                    ? -1
                    : b === '__void_durable_entry.js'
                      ? 1
                      : a.localeCompare(b),
                )
                .map(([name, contents]) => ({
                  type: 'ESModule' as const,
                  path: join(directory, worker, name),
                  contents,
                })),
              durableObjects: { WORKSPACE: object },
            },
          ],
        }),
      );
      return runtime.getWorker('application');
    };
    try {
      const first = await deploy();
      let client = await start(first.id!);
      expect(await (await client.fetch('https://app.test/')).json()).toEqual({
        code: 'one',
        value: 1,
      });
      const second = await deploy('two');
      client = await start(second.id!);
      expect(await (await client.fetch('https://app.test/')).json()).toEqual({
        code: 'two',
        value: 3,
      });
      expect((await rollback(first.id!)).status).toBe(200);
      client = await start(first.id!);
      expect(await (await client.fetch('https://app.test/')).json()).toEqual({
        code: 'one',
        value: 4,
      });
      client = await start(first.id!);
      expect(await (await client.fetch('https://app.test/')).json()).toEqual({
        code: 'one',
        value: 5,
      });
    } finally {
      await runtime?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it('preserves storage across deploy, rollback, removal, and re-addition', async () => {
    const first = await deploy();
    expect(first.events).not.toContainEqual(expect.objectContaining({ event: 'error' }));
    expect(first.id).toBeDefined();
    const initial = await stored(first.id!);
    const namespaceId = initial.durableObjects!.runtime!.namespaces.WorkspaceDurableObject;
    const worker = await durableObjectWorkerName(project.id, binding.className);
    expect(currentRelease(worker)).toBe(first.id);
    const resourceId = (await getProjectResources(env.db, project.id)).find(
      (resource) => resource.type === 'durable-object',
    )!.id;
    const second = await deploy('two');
    expect(second.id).toBeDefined();
    expect(
      (await stored(second.id!)).durableObjects!.runtime!.namespaces.WorkspaceDurableObject,
    ).toBe(namespaceId);
    expect(currentRelease(worker)).toBe(second.id);
    const response = await rollback(first.id!);
    expect(response.status).toBe(200);
    expect(currentRelease(worker)).toBe(first.id);
    expect(provider.state.hostScripts.get(worker)!.classes.get(binding.className)).toBe(
      namespaceId,
    );
    const removed = await deploy('removed', []);
    expect(removed.id).toBeDefined();
    expect(currentRelease(worker)).toBe('');
    const readded = await deploy('re-added');
    expect(readded.id).toBeDefined();
    expect(
      (await stored(readded.id!)).durableObjects!.runtime!.namespaces.WorkspaceDurableObject,
    ).toBe(namespaceId);
    expect(
      (await getProjectResources(env.db, project.id)).find(
        (resource) => resource.type === 'durable-object',
      )!.id,
    ).toBe(resourceId);
    const migrations = writes.filter((write) => write.name === worker && write.metadata.migrations);
    expect(migrations).toHaveLength(1);
    const activeWrite = writes.filter((write) => write.name === worker).at(-1)!;
    expect(activeWrite.modules['__void_durable_entry.js']).toContain(
      'export {WorkspaceDurableObject}',
    );
    expect(activeWrite.modules['__void_durable_entry.js']).toContain('status:404');
    const appWrite = writes.find((write) => write.name === `user-${project.slug}-${readded.id}`)!;
    expect(appWrite.metadata.bindings).toContainEqual({
      type: 'durable_object_namespace',
      name: 'WORKSPACE',
      namespace_id: namespaceId,
    });
  });

  it('restores committed code after a provider write succeeds but loses its acknowledgement', async () => {
    const first = await deploy();
    failPublication = true;
    const failed = await deploy('broken-ack');
    expect(failed.events.some((event) => event.event === 'error')).toBe(true);
    expect(currentRelease(await durableObjectWorkerName(project.id, binding.className))).toBe(
      first.id,
    );
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]!
        .active_deployment_id,
    ).toBe(first.id);
  });

  it('adds another class without migrating or replacing the existing namespace', async () => {
    const first = await deploy();
    const next = await deploy('two-classes', [
      binding,
      { ...binding, bindingName: 'COUNTER', className: 'CounterDurableObject' },
    ]);
    expect(next.id).toBeDefined();
    expect(
      (await stored(next.id!)).durableObjects!.runtime!.namespaces.WorkspaceDurableObject,
    ).toBe((await stored(first.id!)).durableObjects!.runtime!.namespaces.WorkspaceDurableObject);
    expect(
      (await getProjectResources(env.db, project.id)).filter(
        (value) => value.type === 'durable-object',
      ),
    ).toHaveLength(2);
  });

  it('restores active class code when removing it fails before the routing write', async () => {
    const first = await deploy();
    const put = env.ROUTING.put.bind(env.ROUTING);
    let failed = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === project.slug && !failed) {
        failed = true;
        throw new Error('routing publication failed');
      }
      return put(key, value, options);
    });
    const result = await deploy('removed', []);
    expect(result.events.some((event) => event.event === 'error')).toBe(true);
    expect(currentRelease(await durableObjectWorkerName(project.id, binding.className))).toBe(
      first.id,
    );
  });

  it('idles a first release after a lost publication acknowledgement without deleting storage', async () => {
    failPublication = true;
    const failed = await deploy();
    expect(failed.events.some((event) => event.event === 'error')).toBe(true);
    const worker = await durableObjectWorkerName(project.id, binding.className);
    const namespaceId = provider.state.hostScripts.get(worker)!.classes.get(binding.className);
    expect(currentRelease(worker)).toBe('');
    const next = await deploy();
    expect(next.id).toBeDefined();
    expect(
      (await stored(next.id!)).durableObjects!.runtime!.namespaces.WorkspaceDurableObject,
    ).toBe(namespaceId);
  });

  it('cleans up project-owned namespaces through the project deletion workflow', async () => {
    skipOrphanSweepDelay();
    await deploy();
    const worker = await durableObjectWorkerName(project.id, binding.className);
    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(provider.state.hostScripts.has(worker)).toBe(false);
    expect(await getProjectResources(env.db, project.id)).toHaveLength(0);
  });

  it('refreshes script-scoped assets when publishing and rolling back class code', async () => {
    const hash = 'a'.repeat(32);
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${hash}`, new Uint8Array([1]));
    const assetManifest = { '/app.js': { blake3: hash, md5: 'b'.repeat(32), size: 1 } };
    const first = await deploy('one', [binding], {}, assetManifest);
    expect(first.id).toBeDefined();
    const second = await deploy('two', [binding], {}, assetManifest);
    expect(second.id).toBeDefined();
    expect((await rollback(first.id!)).status).toBe(200);
    const worker = await durableObjectWorkerName(project.id, binding.className);
    const published = writes.filter((write) => write.name === worker && write.metadata.assets);
    expect(published).toHaveLength(3);
    for (const write of published) {
      expect(write.metadata.bindings).toContainEqual({ type: 'assets', name: 'ASSETS' });
    }
    const sessions = provider.mock.calls.filter(([url]) =>
      String(url).includes(`/scripts/${worker}/assets-upload-session`),
    );
    expect(sessions).toHaveLength(3);
  });

  it('restores the rotated application token when rolling back encrypted class snapshots', async () => {
    const first = await deploy();
    await deploy('two');
    await requestProxyTokenRotation(env.db, project.id, 'operator', 'operator');
    const result = await advanceProxyTokenRotation(
      env.db,
      env,
      project.id,
      { cfCallsRemaining: 100, deadline: Date.now() + 60_000 },
      { waitMs: 0 },
    );
    expect(result.status).toBe('done');
    expect((await rollback(first.id!)).status).toBe(200);
    const worker = await durableObjectWorkerName(project.id, binding.className);
    const appToken = provider.state.hostScripts
      .get(`user-${project.slug}-${first.id}`)!
      .bindings.find((value) => value.name === '__VOID_PROXY_TOKEN')!.text;
    expect(
      provider.state.hostScripts
        .get(worker)!
        .bindings.find((value) => value.name === '__VOID_PROXY_TOKEN')!.text,
    ).toBe(appToken);
    expect(appToken).toMatch(/^2\./);
  });

  it('rejects client namespace authority before provisioning', async () => {
    const result = await deploy('unsafe', [binding], {
      durableObjects: {
        bindings: [binding],
        runtime: { protocol: 1, namespaces: { WorkspaceDurableObject: 'foreign' } },
      },
    });
    expect(result.response.status).toBe(400);
    expect(JSON.stringify(result.events)).toContain('reserved for the platform');
    expect(writes).toHaveLength(0);
    expect(await getProjectResources(env.db, project.id)).toHaveLength(0);
  });

  it('does not create custom DO resources for an ordinary app', async () => {
    const plain = await deploy('plain', []);
    expect(plain.id).toBeDefined();
    expect(await getProjectResources(env.db, project.id)).toHaveLength(0);
    expect(writes.every((write) => !write.name.startsWith('void-do-'))).toBe(true);
    expect(provider.mock.calls.every(([input]) => !String(input).includes('/containers/'))).toBe(
      true,
    );
  });

  it('isolates the same class name between projects', async () => {
    const first = await deploy();
    const firstProject = project;
    project = await createTestProject(env.db, user.id);
    const second = await deploy();
    const firstManifest = JSON.parse(
      (await getDeployment(env.db, first.id!))!.manifest!,
    ) as DeployManifest;
    const secondManifest = await stored(second.id!);
    expect(firstManifest.durableObjects!.runtime!.namespaces.WorkspaceDurableObject).not.toBe(
      secondManifest.durableObjects!.runtime!.namespaces.WorkspaceDurableObject,
    );
    expect(await durableObjectWorkerName(firstProject.id, binding.className)).not.toBe(
      await durableObjectWorkerName(project.id, binding.className),
    );
  });

  it('fails closed if stored rollback code changed', async () => {
    const first = await deploy();
    const second = await deploy('two');
    await env.STATIC_ASSETS_R2.put(
      `worker-bundles/${project.id}/${first.id}/durable/modules/index.js`,
      'modified',
    );
    const response = await rollback(first.id!);
    expect(response.status).toBe(500);
    expect(currentRelease(await durableObjectWorkerName(project.id, binding.className))).toBe(
      second.id,
    );
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]!
        .active_deployment_id,
    ).toBe(second.id);
  });

  it('encrypts snapshot bindings and binds the ciphertext to the project and release', async () => {
    const first = await deploy('secret', [binding], {
      vars: { PRIVATE_VALUE: 'sensitive-snapshot-value' },
    });
    const object = await env.STATIC_ASSETS_R2.get(
      `worker-bundles/${project.id}/${first.id}/durable/snapshot.json`,
    );
    const raw = await object!.text();
    expect(raw).not.toContain('sensitive-snapshot-value');
    const second = await deploy('next');
    const secondObject = await env.STATIC_ASSETS_R2.get(
      `worker-bundles/${project.id}/${second.id}/durable/snapshot.json`,
    );
    await env.STATIC_ASSETS_R2.put(
      `worker-bundles/${project.id}/${first.id}/durable/snapshot.json`,
      await secondObject!.text(),
    );
    expect((await rollback(first.id!)).status).toBe(500);
    expect(currentRelease(await durableObjectWorkerName(project.id, binding.className))).toBe(
      second.id,
    );
  });

  it('verifies ownership before deleting the namespace', async () => {
    await deploy();
    const resource = (await getProjectResources(env.db, project.id)).find(
      (value) => value.type === 'durable-object',
    )!;
    const host = provider.state.hostScripts.get(resource.cf_id)!;
    const owner = host.bindings.find((value) => value.name === '__VOID_DURABLE_OWNER')!;
    const original = owner.text;
    owner.text = 'foreign-project';
    await expect(
      deleteManagedDurableObject(env as unknown as ApiEnv['Bindings'], project.id, resource),
    ).rejects.toThrow('ownership');
    expect(provider.state.hostScripts.has(resource.cf_id)).toBe(true);
    owner.text = original;
    await deleteManagedDurableObject(env as unknown as ApiEnv['Bindings'], project.id, resource);
    expect(provider.state.hostScripts.has(resource.cf_id)).toBe(false);
  });
});
